# camofox-opencli aggregate image.
#
# Layers three sibling sources (all living under
# /www/dk_project/dk_app/camofox-opencli/ on the server) into one
# supervisord-managed image:
#
#   Stage 1 (cb):  build camofox-browser           -> /opt/camofox
#   Stage 2 (oc):  build opencli  (TS + manifest)  -> /opt/opencli
#   Stage 3 (sg):  build shim + gateway            -> /opt/shim, /opt/gateway
#   Stage 4 (run): runtime layer; supervisord keeps all four processes alive
#
# The compose file passes the two sibling directories as additional build
# contexts (`camofox-browser`, `opencli`) so no git-submodule wiring is
# required and no copying-out-of-context is needed.
#
# Persistent state (browser profiles, cookies, downloads, VNC tokens) lives
# under /home/node/.camofox — bind-mount it from the host so login state
# survives image rebuilds.

# ───────────────────────── Stage 1: camofox-browser ─────────────────────────
FROM node:22-slim AS cb-build

# Force IPv4-first DNS resolution (glibc AAAA → A reordering). v2raya's
# HTTP proxy only covers IPv4; build containers otherwise prefer AAAA and
# hit the slow / rate-limited IPv6 path (33.7 kB/s observed vs 180 kB/s
# over IPv4). One line, no daemon changes, persists in the image.
RUN echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf

# Route build-stage HTTP traffic through the host's v2raya proxy. The Docker
# daemon's `proxies.http-proxy` only affects `docker pull` — it is NOT
# inherited by the build containers' RUN steps. Setting these here makes
# apt/curl/npm use the proxy explicitly. no_*.debian.org is whitelisted
# (bypassed) so the cache, lists, and GPG keys resolve directly via the
# local bridge — saving the proxy from a few hundred small requests.
ENV http_proxy=http://host.docker.internal:20172 \
    https_proxy=http://host.docker.internal:20172 \
    ftp_proxy=http://host.docker.internal:20172 \
    HTTP_PROXY=http://host.docker.internal:20172 \
    HTTPS_PROXY=http://host.docker.internal:20172 \
    no_proxy=localhost,127.0.0.1,.debian.org,.docker.com,.docker.io \
    NO_PROXY=localhost,127.0.0.1,.debian.org,.docker.com,.docker.io

# Pin Debian apt sources to cdn-fastly.deb.debian.org (Fastly CDN cache hit,
# observed < 100ms on the build host). node:22-slim's default
# /etc/apt/sources.list.d/debian.sources uses deb.debian.org, whose SRV-based
# mirror selection can resolve to slow / rate-limited CDN edges from inside
# Docker, causing `apt-get update` to hang for 10+ minutes. By overriding the
# sources file we eliminate DNS SRV lookup entirely.
RUN set -e \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'Types: deb\nURIs: http://cdn-fastly.deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://cdn-fastly.deb.debian.org/debian-security\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' > /etc/apt/sources.list.d/debian.sources

# System deps Camoufox (Firefox) needs at runtime — kept identical to the
# upstream camofox-browser fork so the binary works unchanged. build-essential
# + python3 are present so npm postinstall can compile better-sqlite3's native
# binding (without them camoufox fails with "Could not locate the bindings
# file" when launching any persistent browser context).
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc python3-websockify python3 make g++ \
        libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 \
        libasound2 libdrm2 libgbm1 libxcomposite1 libxcursor1 \
        libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 \
        libxss1 libxtst6 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libpango-1.0-0 libpangocairo-1.0-0 libxkbcommon0 \
        libxshmfence1 fonts-freefont-ttf fonts-liberation \
        fonts-noto fonts-noto-color-emoji fontconfig \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# noVNC static web client for the VNC HTML page on :6080.
# Use git clone first, fall back to the GitHub tarball if the build host
# blocks git-over-HTTPS (common in Docker China base images).
RUN set -e; \
    if git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC 2>/dev/null; then \
        rm -rf /opt/noVNC/.git; \
    else \
        echo "git clone failed, falling back to codeload tarball"; \
        curl -fsSL https://codeload.github.com/novnc/noVNC/tar.gz/refs/heads/master -o /tmp/novnc.tgz \
        && mkdir -p /opt/noVNC \
        && tar -xzf /tmp/novnc.tgz -C /opt/noVNC --strip-components=1 \
        && rm /tmp/novnc.tgz; \
    fi

WORKDIR /build
# Copy context — the compose `additional_contexts.cb` resolves to the
# camofox-browser fork directory.
COPY --from=camofox-browser . /build

# Install once (includes devDeps so tsc is available), build, then prune
# dev-only entries in place. Avoids re-running the install resolver twice.
# Use --ignore-scripts to skip the camoufox-js postinstall (now redundant
# since we vendor the binary explicitly above) but THEN rebuild
# better-sqlite3 so its native binding is compiled for this image's Node
# version. Without the explicit rebuild, npm ci --ignore-scripts leaves
# the .node file out and camofox crashes with "Could not locate the
# bindings file" on first POST /tabs.
RUN npm ci --ignore-scripts \
 && npm run build \
 && npm rebuild better-sqlite3 \
 && npm prune --omit=dev

# Pre-stage the Camoufox Firefox binary into /home/node/.cache/camoufox/
# (where camoufox-js expects to find it). Downloaded once on the build
# host via `gh release download` (authenticated, no IP-share rate limits),
# then COPY'd into the cb-build stage here. This avoids re-downloading on
# every build and avoids the v2raya exit IP getting throttled by GitHub.
#
# camoufox-js writes a version.json sidecar with the schema
#   { version: "<firefox-version>", release: "<release-tag>" }
# which its installer normally does; we materialize it explicitly below.
ARG CAMOUFOX_RELEASE_TAG=v152.0.4-beta.28

# Bundle the pre-downloaded zip + GeoIP DB + a small metadata file in the
# build context. Both come from authenticated `gh release download` calls
# on the build host (avoids the v2raya-shared-IP rate limit).
COPY camoufox-bin/camoufox-bin.zip /tmp/camoufox.zip
COPY camoufox-bin/version.json    /tmp/version.json
COPY camoufox-bin/GeoLite2-City.mmdb /tmp/GeoLite2-City.mmdb

RUN mkdir -p /home/node/.cache/camoufox \
 && apt-get update && apt-get install -y --no-install-recommends unzip \
 && chown -R node:node /home/node/.cache /tmp/camoufox.zip /tmp/version.json /tmp/GeoLite2-City.mmdb \
 && unzip -q /tmp/camoufox.zip -d /home/node/.cache/camoufox \
 && cp /tmp/version.json /home/node/.cache/camoufox/version.json \
 && cp /tmp/GeoLite2-City.mmdb /home/node/.cache/camoufox/GeoLite2-City.mmdb \
 && chmod -R 755 /home/node/.cache/camoufox \
 && rm /tmp/camoufox.zip /tmp/version.json /tmp/GeoLite2-City.mmdb \
 && apt-get purge -y --auto-remove unzip \
 && chown -R node:node /home/node/.cache

# Trim sources + lockfiles we no longer need at runtime.
RUN rm -rf node_modules/.cache src tsconfig.json package-lock.json

# ───────────────────────── Stage 2: opencli (daemon) ─────────────────────────
FROM node:22-slim AS oc-build

WORKDIR /build
COPY --from=opencli . /build

RUN npm ci --ignore-scripts

# OpenCLI's build script chains tsc + manifest generation + yaml copies.
# Build must succeed — without dist/src/daemon.js supervisord can't start it.
RUN npm run build

# Keep dist, cli-manifest.json, clis/, scripts/. Drop everything else.
RUN rm -rf node_modules/.cache src tsconfig.json package-lock.json \
        bun.lock docs README.md CHANGELOG.md

# ───────────────────────── Stage 3: shim + gateway (single repo) ─────────────────────────
FROM node:22-slim AS sg-build

WORKDIR /build
COPY package.json package-lock.json tsconfig.json vitest.config.ts /build/
COPY src/ /build/src/

RUN npm ci --ignore-scripts && npm run build

FROM node:22-slim AS runtime

# Force IPv4-first DNS resolution. See cb-build comment — same root cause
# (v2raya IPv4-only proxy vs IPv6-preferring glibc), affects apt + curl + npm.
RUN echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf

# Route build-stage HTTP traffic through the host's v2raya proxy. See
# cb-build comment — daemon-level proxies are not inherited by build
# containers, so we re-declare here. Runtime containers also use these when
# they need to reach external HTTP endpoints at build time.
ENV http_proxy=http://host.docker.internal:20172 \
    https_proxy=http://host.docker.internal:20172 \
    HTTP_PROXY=http://host.docker.internal:20172 \
    HTTPS_PROXY=http://host.docker.internal:20172 \
    no_proxy=localhost,127.0.0.1,.debian.org \
    NO_PROXY=localhost,127.0.0.1,.debian.org

# Pin Debian apt sources to cdn-fastly.deb.debian.org (see cb-build comment
# above for why — avoids the same DNS-SRV-induced apt-get hang).
RUN set -e \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'Types: deb\nURIs: http://cdn-fastly.deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://cdn-fastly.deb.debian.org/debian-security\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' > /etc/apt/sources.list.d/debian.sources

# Common runtime dependencies. xvfb / x11vnc / noVNC for the VNC layer;
# the GTK / X11 / font stack are required by Camoufox's Firefox binary at
# launch (XPCOMGlueLoad libmozgtk.so, etc.) and were lost when we split
# build vs. runtime stages — they must be reinstalled here, not just in
# the cb-build stage.
# ffmpeg: required by yt-dlp to remux HLS / m3u8 streams (live broadcasts,
# dash-to-mp4). Without it yt-dlp returns "m3u8 download detected but
# ffmpeg could not be found" and the gateway surfaces YT_DLP_FAILED.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc python3-websockify curl ca-certificates \
        supervisor git yt-dlp python3-pip ffmpeg \
        libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 \
        libasound2 libdrm2 libgbm1 libxcomposite1 libxcursor1 \
        libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 \
        libxss1 libxtst6 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libpango-1.0-0 libpangocairo-1.0-0 libxkbcommon0 \
        libxshmfence1 fonts-freefont-ttf fonts-liberation \
        fonts-noto fonts-noto-color-emoji fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Some upstream yt-dlp packages lag behind YouTube's JS challenges; if the
# apt-installed version is older than 2026.x, pip-install the latest. Skipped
# silently on networks without internet.
RUN yt-dlp --version || true \
    && pip3 install --break-system-packages --no-cache-dir -U "yt-dlp>=2026.7.0" 2>/dev/null || true \
    && yt-dlp --version || true

# deno: yt-dlp's EJS (External JavaScript Solver) for YouTube signature
# extraction. Without a JS runtime yt-dlp falls back to "Some formats may be
# missing" / "Requested format is not available" because YouTube's signature
# derivation needs JS evaluation. deno is a single static binary distributed
# on GitHub (no apt package in Debian bookworm).
RUN set -e; \
    apt-get install -y --no-install-recommends unzip 2>/dev/null \
    && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip \
    && apt-get purge -y --auto-remove unzip 2>/dev/null \
    && /usr/local/bin/deno --version

# Pre-fetch yt-dlp's EJS challenge solver scripts from GitHub so the runtime
# container doesn't need network on first video_download. yt-dlp will look
# these up under the node user's $HOME/.cache/yt-dlp/ejs on first use; seeding
# them here avoids the "Remote components ... were skipped" warning and lets
# YouTube downloads work without extra runtime flags.
RUN set -e; \
    mkdir -p /home/node/.cache/yt-dlp/ejs \
    && chown -R node:node /home/node/.cache \
    && su -s /bin/bash node -c "yt-dlp --remote-components ejs:github -F https://www.youtube.com/watch?v=dQw4w9WgXcQ >/dev/null 2>&1 || true" \
    && ls -la /home/node/.cache/yt-dlp/ejs

# yt-dlp lives in the runtime layer — handy for transcript adapters and
# already required by camofox-browser for YouTube extraction.
#
# IMPORTANT: do NOT download a pinned github release here. The pip-installed
# version from the apt-get layer above is newer; overwriting `/usr/local/bin/
# yt-dlp` with a stale release reverts youtube downloads to "older than 90
# days" failures (B 站 412, youtube signature-solver deprecation). The
# `yt-dlp --version` we re-check on the next line is the source of truth.

# noVNC static client (re-installed here so the runtime layer is self-
# contained even if Stage 1 changed in the future). Same tarball fallback
# as cb-build (some base images block git-over-HTTPS).
RUN set -e; \
    if git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC 2>/dev/null; then \
        rm -rf /opt/noVNC/.git; \
    else \
        echo "git clone failed, falling back to codeload tarball"; \
        curl -fsSL https://codeload.github.com/novnc/noVNC/tar.gz/refs/heads/master -o /tmp/novnc.tgz \
        && mkdir -p /opt/noVNC \
        && tar -xzf /tmp/novnc.tgz -C /opt/noVNC --strip-components=1 \
        && rm /tmp/novnc.tgz; \
    fi

# Layer in the three pre-built artifacts.
COPY --from=cb-build /build/        /opt/camofox/
COPY --from=cb-build /home/node/.cache/camoufox/ /home/node/.cache/camoufox/
COPY --from=oc-build /build/        /opt/opencli/
COPY --from=sg-build /build/dist/shim/      /opt/shim/
COPY --from=sg-build /build/dist/gateway/   /opt/gateway/

# Install production node_modules for shim + gateway (the build stage only
# ran `npm ci` once, including devDeps for tsc — re-install with omit=dev
# so the dist/ can actually run).
RUN cd /opt/shim && npm install --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/.cache
RUN cd /opt/gateway && npm install --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/.cache

# Render Camofox server.js executable from the correct working dir
# (supervisord runs `cd /opt/camofox && node server.js`).
WORKDIR /opt/camofox

# Persistent data paths — bind-mount the host's ./data directory here so
# browser profiles, cookies, downloads, and VNC tokens survive rebuilds.
RUN mkdir -p /home/node/.camofox/profiles /home/node/.camofox/downloads /var/log/gateway /opt/gateway/tmp \
 && chown -R node:node /home/node/.camofox /var/log/gateway /opt/gateway

# Expose the opencli CLI on PATH so `opencli <site> <command>` works
# from a `docker exec` shell and matches what the gateway spawns.
# `/opt/opencli/dist/src/main.js` already has `#!/usr/bin/env node`
# + mode 0755 (set by opencli's prebuild-manifest hook), so a symlink
# is enough — no wrapper script, no `npm link` (which would mutate
# node_modules across layers).
RUN ln -sf /opt/opencli/dist/src/main.js /usr/local/bin/opencli

# Pin opencli's default Browser Bridge context to "fectivnfy" so the same
# logged-in user the gateway's VNC /mcp login tool targets is also the user
# opencli adapters (e.g. `opencli bilibili download`) inherit. Without this
# opencli spawns the ephemeral "default" user, sees no SESSDATA cookie, and
# yt-dlp reports HTTP 412 / sign-in gates on every download.
RUN mkdir -p /home/node/.opencli \
    && printf '{"defaultContextId":"fectivnfy"}\n' > /home/node/.opencli/browser-profiles.json \
    && chown -R node:node /home/node/.opencli

# Supervisord config — defines the four processes (camofox, opencli-
# daemon, shim, gateway). Volumes & env wiring lives in docker-compose.
COPY supervisord.conf /etc/supervisor/conf.d/camofox-opencli.conf

# Wrapping entrypoint fixes bind-mount ownership before dropping privs.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    CAMOFOX_PROFILES_DIR=/home/node/.camofox/profiles \
    CAMOFOX_PORT=9377 \
    PORT=9377

EXPOSE 9377 6080 19825 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:9377/health || exit 1

VOLUME ["/home/node/.camofox", "/var/log/gateway"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/camofox-opencli.conf"]
