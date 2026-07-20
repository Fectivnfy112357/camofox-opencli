# syntax=docker/dockerfile:1.6
#
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

# System deps Camoufox (Firefox) needs at runtime — kept identical to the
# upstream camofox-browser fork so the binary works unchanged.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc python3-websockify \
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
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC \
 && rm -rf /opt/noVNC/.git

WORKDIR /build
# Copy context — the compose `additional_contexts.cb` resolves to the
# camofox-browser fork directory.
COPY --from=camofox-browser . /build

# Install once (includes devDeps so tsc is available), build, then prune
# dev-only entries in place. Avoids re-running the install resolver twice.
RUN npm ci --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev

# Pre-warm Camoufox binary cache so first browser launch isn't a 300MB
# download. Tolerated failure: `npx camoufox-js fetch` exits non-zero on
# some networks; runtime retries as long as /home/node/.cache/camoufox
# was populated by mounting the host volume in compose.
RUN npx --yes camoufox-js fetch || true

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

# ───────────────────────── Stage 3: shim + gateway ─────────────────────────
FROM node:22-slim AS sg-build

WORKDIR /build/shim
COPY src/ /build/shim/src/
COPY package.json package-lock.json tsconfig.json vitest.config.ts /build/shim/

RUN cd /build/shim && npm ci --ignore-scripts && npm run build

WORKDIR /build/gateway
COPY gateway/package.json gateway/package-lock.json gateway/tsconfig.json gateway/vitest.config.ts /build/gateway/
COPY gateway/src/ /build/gateway/src/

# The gateway reads cli-manifest.json at runtime from OPENCLI_MANIFEST env.
# We bake a copy in at /opt/opencli/cli-manifest.json via stage 4 — the
# gateway build itself only needs its own sources + sdk.
RUN cd /build/gateway && npm ci --ignore-scripts && npm run build

FROM node:22-slim AS runtime

# Common runtime dependencies (xvfb, x11vnc, noVNC). camofox-binary deps
# come along via the camofox-browser layer, which already ran apt-get.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc python3-websockify curl ca-certificates \
        supervisor git \
    && rm -rf /var/lib/apt/lists/*

# noVNC static client (re-installed here so the runtime layer is self-
# contained even if Stage 1 changed in the future).
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC \
 && rm -rf /opt/noVNC/.git

# yt-dlp lives in the runtime layer — handy for transcript adapters and
# already required by camofox-browser for YouTube extraction.
ARG YT_DLP_VERSION=2026.02.21
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

# Layer in the three pre-built artifacts.
COPY --from=cb-build /build/        /opt/camofox/
COPY --from=oc-build /build/        /opt/opencli/
COPY --from=sg-build /build/shim/dist/      /opt/shim/dist/
COPY --from=sg-build /build/shim/package.json /opt/shim/
COPY --from=sg-build /build/gateway/dist/   /opt/gateway/dist/
COPY --from=sg-build /build/gateway/package.json /opt/gateway/

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
RUN mkdir -p /home/node/.camofox/profiles /home/node/.camofox/downloads /var/log/gateway \
 && chown -R node:node /home/node/.camofox /var/log/gateway

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
