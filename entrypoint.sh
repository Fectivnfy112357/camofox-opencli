#!/bin/sh
# entrypoint — fix bind-mount ownership, ensure Camoufox binary is cached,
# then drop privs to supervisord.
#
# /home/node/.camofox and /var/log/gateway come in as host-side bind mounts
# whose UID/GID rarely matches the `node` user inside the container. Without
# chown here, the gateway can't write its JSONL log and the browser can't
# persist cookies. The camoufox-js fetch retries the binary download — the
# build step times out after 90s on slow networks, so the runtime image
# may arrive without /home/node/.cache/camoufox; we retry here before the
# browser pool would otherwise 500 on "Camoufox version could not be
# determined".

set -eu

fix_mount() {
    dir="$1"
    if [ -d "$dir" ]; then
        chown -R node:node "$dir" 2>/dev/null || true
    fi
}

fix_mount /home/node/.camofox
fix_mount /var/log/gateway

# Pre-fetch camoufox binary as the node user. Use a 180s timeout — long
# enough for slow proxy / CDNs, short enough that a totally unreachable
# CDN doesn't block supervisord indefinitely. Failure is tolerated;
# POST /tabs will then surface a clear "Camoufox version undetermined"
# error so the caller can retry.
if command -v npx >/dev/null 2>&1; then
    echo "[entrypoint] pre-warming camoufox-js (180s timeout)..."
    timeout --kill-after=10s 180s su node -c 'timeout 175s npx --yes camoufox-js fetch' \
        || echo "[entrypoint] camoufox fetch failed/skipped; runtime will surface error"
fi

# Hand off to the CMD. We stay root on purpose — supervisord re-execs as
# the configured `user=` for each program entry below.
exec "$@"
