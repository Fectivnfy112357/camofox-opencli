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

# Camoufox keeps cache + GeoIP DB at /home/node/.cache/camoufox. Both this
# directory and any pre-baked files inside it are owned by root in the
# image; the runtime program runs as `node` and needs write access to
# download GeoLite2-City.mmdb on demand. chown here so a freshly-extracted
# cache survives the very first browser launch.
if [ -d /home/node/.cache/camoufox ]; then
    chown -R node:node /home/node/.cache/camoufox 2>/dev/null || true
fi

# Hand off to the CMD. We stay root on purpose — supervisord re-execs as
# the configured `user=` for each program entry below.
exec "$@"
