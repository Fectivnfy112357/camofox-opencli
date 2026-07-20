#!/bin/sh
# entrypoint — fix bind-mount ownership then drop privs to supervisord.
#
# /home/node/.camofox and /var/log/gateway come in as host-side bind mounts
# whose UID/GID rarely matches the `node` user inside the container. Without
# chown here, the gateway can't write its JSONL log and the browser can't
# persist cookies. Run once on every start, costs nothing if ownership
# already matches.
#
# Note: camoufox binary is pre-baked into the runtime image at build time
# (see Dockerfile cb-build stage), so no fetch is needed here — and the
# container's runtime network has no v2raya proxy, so any runtime fetch
# would fail.

set -eu

fix_mount() {
    dir="$1"
    if [ -d "$dir" ]; then
        chown -R node:node "$dir" 2>/dev/null || true
    fi
}

fix_mount /home/node/.camofox
fix_mount /var/log/gateway

# Hand off to the CMD. We stay root on purpose — supervisord re-execs as
# the configured `user=` for each program entry below.
exec "$@"
