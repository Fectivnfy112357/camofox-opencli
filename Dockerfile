# ─── Stage 1: Build OpenCLI CLI ──────────────────────────────────
FROM node:22-slim AS opencli-build

WORKDIR /app
COPY opencli/package.json opencli/package-lock.json ./
RUN npm ci
COPY opencli/ ./
RUN npm run build

# ─── Stage 2: Build Camofox Shim ──────────────────────────────────
FROM node:22-slim AS shim-build

WORKDIR /app
COPY camofox-shim/package.json camofox-shim/package-lock.json ./
RUN npm ci
COPY camofox-shim/ ./
# Fix executable bit on .bin shims — npm ci sometimes drops +x when sources
# come from a host with non-POSIX mounts (e.g. bind-mounted on Windows).
RUN chmod -R +x node_modules/.bin || true
RUN npx tsc

# ─── Stage 2b: Build OpenCLI Gateway ──────────────────────────────
FROM node:22-slim AS gateway-build

WORKDIR /app
COPY camofox-shim/gateway/package.json camofox-shim/gateway/package-lock.json ./
RUN npm ci
COPY camofox-shim/gateway/ ./
RUN chmod -R +x node_modules/.bin || true
RUN npx tsc

# ─── Stage 2c: Camoufox binaries are fetched at runtime by the fork ───
# The camofox-browser fork's `postinstall` script (scripts/postinstall.js)
# runs `npx camoufox-js fetch` during `npm install`, populating
# /root/.cache/camoufox/. We let that happen inline rather than mirroring
# the asset from a separate Dockerfile stage (the asset URL shape changes
# between releases and was failing to resolve against github.com/daijro).

# ─── Stage 3: Build Camofox Browser fork from source ──────────────
# Build the user's local fork of Camofox Browser (sibling submodule) instead
# of pulling the upstream ghcr.io image, so changes to the fork (including
# the GET /sessions/:userId/cookies endpoint) are picked up on rebuild.
FROM node:22-slim AS camofox-base

# Build-time network: the Docker build container runs on the bridge network
# and the host's v2raya tun hijack does not reach into it (raw `curl
# https://github.com` times out). Point apt/curl/npm at the host v2raya HTTP
# proxy so debian packages, the yt-dlp binary, and `npx camoufox-js fetch`
# (run by the fork's postinstall) can reach github.com / objects.githubusercontent.com.
# Override per-call with `--build-arg BUILDER_HTTP_PROXY=` to disable or change
# the proxy host (e.g. "http://host.docker.internal:20172" on host-gateway setups).
ARG BUILDER_HTTP_PROXY=http://172.17.0.1:20172
ENV HTTP_PROXY=${BUILDER_HTTP_PROXY} \
    HTTPS_PROXY=${BUILDER_HTTP_PROXY} \
    http_proxy=${BUILDER_HTTP_PROXY} \
    https_proxy=${BUILDER_HTTP_PROXY} \
    npm_config_strict_ssl=false

# Firefox / Camoufox runtime dependencies (mirrors camofox-browser/Dockerfile).
# `Acquire::http::Proxy` is required — apt does not consult $HTTP_PROXY.
RUN echo "Acquire::http::Proxy \"${BUILDER_HTTP_PROXY}\";\nAcquire::https::Proxy \"${BUILDER_HTTP_PROXY}\";" \
        > /etc/apt/apt.conf.d/99proxy \
    && apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 \
    libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    libegl1-mesa libgl1-mesa-dri libgbm1 \
    xvfb \
    fonts-liberation fonts-noto-color-emoji fontconfig \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/apt.conf.d/99proxy

# yt-dlp for YouTube transcript extraction
RUN curl -fsSL --proxy "${BUILDER_HTTP_PROXY}" \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy the full fork source first. The fork's postinstall.js (which runs
# `npx camoufox-js fetch` to populate /root/.cache/camoufox/) lives under
# ./scripts/ and must be present BEFORE npm ci runs lifecycle scripts.
COPY camofox-browser/ ./

# Install Camofox Browser fork dependencies (production only). Pass
# --ignore-scripts here because the fork's postinstall.js runs
# `npx camoufox-js fetch` through the `impit` native client, which bypasses
# $HTTP_PROXY and is unreliable in a build-time Docker container. The
# Camoufox binary + assets are injected separately from the host cache (see
# the COPY below) so this stage doesn't need network access at all.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Optional: install default plugin deps (apt + post-install hooks). Skip
# failures — the server still boots without every plugin's deps.
RUN sh scripts/install-plugin-deps.sh || true

# Inject the Camoufox binary bundle into the image without going through
# `camoufox-js fetch`. The build context `camoufox-cache` must be supplied by
# the caller (deploy.sh provides it from the host's /root/.cache/camoufox
# via additional_contexts in docker-compose.yml). camofox-server.js runs as
# the `node` user, whose $HOME is /home/node — camoufox-js therefore expects
# the cache at /home/node/.cache/camoufox (not /root/.cache/camoufox). Copy
# there and chown so node can read every entry.
COPY --from=camoufox . /home/node/.cache/camoufox/
RUN chown -R node:node /home/node/.cache/camoufox

# Inject the two runtime assets camoufox-js pulls at browser launch time
# (mozilla.org / P3TERX/GeoLite.mmdb github release). They arrive via the
# `runtime-addons` named build context populated by deploy.sh from the host
# /opt/camoufox-runtime/. The context may be absent when devs skip the
# pre-stage, so each COPY tolerates the empty `/dev/null` fallback by being
# skipped silently.
COPY --from=runtime-addons GeoLite2-City.mmdb /home/node/.cache/camoufox/GeoLite2-City.mmdb
COPY --from=runtime-addons addons/UBO/ /home/node/.cache/camoufox/addons/UBO/
RUN chown -R node:node /home/node/.cache/camoufox
# Re-assert ownership in case the COPYs above wrote files as root — camofox
# runs as the `node` user and bails if it can't read its cache entries.
RUN chown -R node:node /home/node/.cache/camoufox 2>/dev/null || true

ENV NODE_ENV=production
ENV CAMOFOX_PORT=9377

EXPOSE 9377

# ─── Stage 4: Final image ─────────────────────────────────────────
FROM camofox-base

# Switch to root for the multi-process supervisor install
ARG BUILDER_HTTP_PROXY=http://172.17.0.1:20172
ENV HTTP_PROXY=${BUILDER_HTTP_PROXY} \
    HTTPS_PROXY=${BUILDER_HTTP_PROXY} \
    http_proxy=${BUILDER_HTTP_PROXY} \
    https_proxy=${BUILDER_HTTP_PROXY}

USER root

RUN echo "Acquire::http::Proxy \"${BUILDER_HTTP_PROXY}\";\nAcquire::https::Proxy \"${BUILDER_HTTP_PROXY}\";" \
        > /etc/apt/apt.conf.d/99proxy \
    && apt-get update && apt-get install -y --no-install-recommends supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/apt.conf.d/99proxy

# ── Install OpenCLI globally ──────────────────────────────────────
COPY --from=opencli-build /app/dist /opt/opencli/dist
COPY --from=opencli-build /app/node_modules /opt/opencli/node_modules
COPY --from=opencli-build /app/clis /opt/opencli/clis
COPY --from=opencli-build /app/skills /opt/opencli/skills
COPY --from=opencli-build /app/cli-manifest.json /opt/opencli/
COPY --from=opencli-build /app/package.json /opt/opencli/
RUN ln -s /opt/opencli/dist/src/main.js /usr/local/bin/opencli

# ── Install Shim ──────────────────────────────────────────────────
COPY --from=shim-build /app/dist /opt/shim/dist
COPY --from=shim-build /app/node_modules /opt/shim/node_modules
COPY --from=shim-build /app/package.json /opt/shim/

# ── Install Gateway ───────────────────────────────────────────────
COPY --from=gateway-build /app/dist /opt/gateway/dist
COPY --from=gateway-build /app/node_modules /opt/gateway/node_modules
COPY --from=gateway-build /app/package.json /opt/gateway/

# ── Supervisor config ─────────────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# ── Gateway log dir (writable by 'node', mounted out via compose) ──
RUN mkdir -p /var/log/gateway && chown -R node:node /var/log/gateway

# ── Entrypoint: chown bind-mounted log dir, then exec supervisord ──
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV CAMOFOX_URL=http://localhost:9377
ENV SHIM_PORT=19825
ENV GATEWAY_PORT=8080
ENV OPENCLI_MANIFEST=/opt/opencli/cli-manifest.json

EXPOSE 9377 6080 19825 8080
CMD ["/entrypoint.sh"]
