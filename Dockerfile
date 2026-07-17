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

# ─── Stage 3: Final image ─────────────────────────────────────────
FROM ghcr.io/redf0x1/camofox-browser:latest

# Switch to root — base image runs as 'node' user
USER root

# supervisord for multi-process management
RUN apt-get update && apt-get install -y supervisor && rm -rf /var/lib/apt/lists/*

# ── Entrypoint wrapper — runs camofox's compiled server.js ──
COPY camofox-browser/entrypoint-camofox.sh /app/entrypoint-camofox.sh
RUN chmod +x /app/entrypoint-camofox.sh

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