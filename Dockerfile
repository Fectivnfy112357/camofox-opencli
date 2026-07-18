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

# ─── Stage 2c: Fetch Camoufox + yt-dlp binaries ────────────────────
# Pinned to the latest Camoufox release (override via --build-arg).
ARG CAMOUFOX_VERSION=152.0.4
ARG CAMOUFOX_RELEASE=beta.27

FROM alpine:3.20 AS camoufox-bin

ARG CAMOUFOX_VERSION
ARG CAMOUFOX_RELEASE

RUN apk add --no-cache curl ca-certificates unzip \
    && mkdir -p /out \
    && curl -fSL "https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}/camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-lin.x86_64.zip" -o /tmp/camoufox.zip \
    && unzip -q /tmp/camoufox.zip -d /out \
    && test -f /out/camoufox-bin || (echo "camoufox-bin missing" && ls -R /out && exit 1) \
    && chmod -R 755 /out \
    && printf '{"version":"%s","release":"%s"}\n' "$CAMOUFOX_VERSION" "$CAMOUFOX_RELEASE" > /out/version.json

# ─── Stage 3: Build Camofox Browser fork from source ──────────────
# Build the user's local fork of Camofox Browser (sibling submodule) instead
# of pulling the upstream ghcr.io image, so changes to the fork (including
# the GET /sessions/:userId/cookies endpoint) are picked up on rebuild.
FROM node:22-slim AS camofox-base

# Firefox / Camoufox runtime dependencies (mirrors camofox-browser/Dockerfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 \
    libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    libegl1-mesa libgl1-mesa-dri libgbm1 \
    xvfb \
    fonts-liberation fonts-noto-color-emoji fontconfig \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Inherit the Camoufox binary from the camoufox-bin stage
COPY --from=camoufox-bin /out /root/.cache/camoufox

# yt-dlp for YouTube transcript extraction
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Install Camofox Browser fork dependencies (production only)
COPY camofox-browser/package.json camofox-browser/package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# Copy the rest of the fork source. server.js is ESM (type: module),
# so we run it directly without a build step.
COPY camofox-browser/server.js ./
COPY camofox-browser/camofox.config.json ./
COPY camofox-browser/lib ./lib
COPY camofox-browser/plugins ./plugins
COPY camofox-browser/scripts ./scripts
COPY camofox-browser/bin ./bin

# Optional: install default plugin deps (apt + post-install hooks). Skip
# failures — the server still boots without every plugin's deps.
RUN sh scripts/install-plugin-deps.sh || true

ENV NODE_ENV=production
ENV CAMOFOX_PORT=9377

EXPOSE 9377

# ─── Stage 4: Final image ─────────────────────────────────────────
FROM camofox-base

# Switch to root for the multi-process supervisor install
USER root

RUN apt-get update && apt-get install -y --no-install-recommends supervisor \
    && rm -rf /var/lib/apt/lists/*

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
