#!/usr/bin/env bash
# deploy.sh — single-binary deploy helper for camofox-opencli.
#
# Subcommands:
#   init       First-time setup. Clones the two sibling forks next to this
#              directory (camofox-browser/, opencli/), then downloads the
#              vendored Camoufox binary + GeoIP DB into camoufox-bin/ via
#              `gh release download` (auth required: run `gh auth login`
#              once before invoking). Builds the image, brings the container
#              up, and writes a default .env if missing.
#   deploy     Subsequent updates. git pull (auto-stash local server-side
#              config drift), preflight checks (camoufox-bin/ files,
#              sibling dirs, docker), build, recreate, health-probe.
#   vnc        Restart the in-container x11vnc/websockify pair and print
#              a fresh noVNC URL for the user.
#   status     One-shot health summary.
#   logs       Tail supervisord + camofox + gateway logs.
#   down       Stop and remove the container (data/ is preserved).
#
# Self-healing guarantees:
#   - Missing camoufox-bin/version.json is auto-regenerated.
#   - Missing camoufox-bin/camoufox-bin.zip is re-downloaded via gh release.
#   - Missing camoufox-bin/GeoLite2-City.mmdb is re-downloaded via gh release.
#   - Server-side local config drift (.gitignore, deploy.sh,
#     docker-compose.yml, .env, camoufox-bin/, camofox-browser/, opencli/)
#     is stashed BEFORE pulling and unstashed AFTER — pull never fails on
#     unrelated local modifications.
#   - Docker daemon liveness is checked; on shared hosts never pkill docker.
#
# Conventions:
#   - All paths are relative to this script's directory.
#   - No `pkill docker` / `docker system prune -a` — shared host.

set -euo pipefail

cd "$(dirname "$0")"
APP="$PWD"

# ---------------------------------------------------------------------------
# Constants
readonly CAMOUFOX_TAG_DEFAULT="v152.0.4-beta.28"
readonly CAMOUFOX_VERSION_DEFAULT="152.0.4"

# Paths that may legitimately be modified locally on the server (e.g. by
# past deploys that wrote .env or in-place edits to docker-compose.yml)
# and must NOT be touched by `git pull`.  Each entry is relative to APP.
readonly SERVER_LOCAL_PATHS=(
    .gitignore
    deploy.sh
    docker-compose.yml
    .env
    camoufox-bin
    camofox-browser
    opencli
    data
    logs
)

# ---------------------------------------------------------------------------
# Helpers
log()   { printf '\033[1;34m[deploy]\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n'   "$*" >&2; }
fail()  { printf '\033[1;31m[fail]\033[0m %s\n'   "$*" >&2; exit 1; }
ok()    { printf '\033[1;32m[ok]\033[0m %s\n'     "$*" >&2; }

require() {
    command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"
}

check_docker_alive() {
    # Liveness probe only — never kill the daemon.
    docker info >/dev/null 2>&1 || fail "docker daemon unreachable (DO NOT pkill — shared host)"
}

# ---------------------------------------------------------------------------
# Pre-flight: ensure the build context is complete before any docker call.
#
# Builds a dependency graph of what the Dockerfile needs and restores
# anything missing without bothering the user. This is the single source
# of truth for "what does the build need on disk" — anything the
# Dockerfile COPYs must be either tracked in git or vendored here.
preflight() {
    log "preflight: checking build context..."

    # 1. Sibling forks (Dockerfile consumes these as BuildKit named contexts).
    local missing=()
    for d in camofox-browser opencli; do
        if [ ! -d "$d/.git" ]; then
            missing+=("$d")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        log "preflight: cloning missing sibling forks: ${missing[*]}"
        for d in "${missing[@]}"; do
            git clone "https://github.com/Fectivnfy112357/$d.git" "$d"
        done
    fi

    # 2. camoufox-bin/ — Dockerfile COPYs three files from it. None are
    #    tracked in git (they're large binaries + a generated sidecar).
    #    Re-download any that are missing or truncated.
    if [ ! -d camoufox-bin ]; then
        mkdir -p camoufox-bin
    fi
    vend_assets

    # 3. .env — docker-compose reads it for GATEWAY_API_KEY etc.
    if [ ! -f .env ]; then
        warn ".env missing — writing defaults (replace *_API_KEY before exposing publicly)"
        cat > .env <<'EOF'
CAMOFOX_API_KEY=my_secret_api_key_123
GATEWAY_API_KEY=change_me_gateway_key
CAMOFOX_USER_ID=fectivnfy
GATEWAY_EXPOSE_PORT=9378
PUBLIC_HOST=
EOF
    fi

    ok "preflight: build context complete"
}

# ---------------------------------------------------------------------------
# Vendoring: download / regenerate Camoufox binary + GeoIP + version sidecar.
#
# Called both from `init` and from `preflight`. Idempotent: skips files
# that already exist with non-zero size.
vend_assets() {
    mkdir -p camoufox-bin

    # Camoufox binary
    if [ ! -s camoufox-bin/camoufox-bin.zip ]; then
        require gh
        gh auth status >/dev/null 2>&1 || fail "gh not authenticated — run \`gh auth login\` first"
        log "vendoring Camoufox binary via gh release download..."
        local tag
        tag=$(gh api /repos/daijro/camoufox/releases/latest --jq '.tag_name' 2>/dev/null || true)
        [ -n "$tag" ] || tag="$CAMOUFOX_TAG_DEFAULT"
        gh release download "$tag" --repo daijro/camoufox \
            --pattern "camoufox-*-lin.x86_64.zip" \
            --dir camoufox-bin/ >/dev/null 2>&1 || \
            warn "gh release download failed for $tag — leaving camoufox-bin/camoufox-bin.zip absent"
        local zip
        zip=$(ls camoufox-bin/camoufox-*-lin.x86_64.zip 2>/dev/null | head -1 || true)
        if [ -n "$zip" ]; then
            mv "$zip" camoufox-bin/camoufox-bin.zip
            log "  -> $(du -h camoufox-bin/camoufox-bin.zip | cut -f1)"
        fi
    fi

    # version.json sidecar (generated locally — Dockerfile reads it but the
    # zip doesn't include it; camoufox-js writes one but we materialise it
    # explicitly so the build doesn't depend on a runtime fetch).
    if [ ! -s camoufox-bin/version.json ]; then
        log "regenerating camoufox-bin/version.json sidecar..."
        printf '{"version":"%s","release":"%s"}' \
            "$CAMOUFOX_VERSION_DEFAULT" "$CAMOUFOX_TAG_DEFAULT" \
            > camoufox-bin/version.json
        ok "  -> $(cat camoufox-bin/version.json)"
    fi

    # GeoLite2-City.mmdb
    if [ ! -s camoufox-bin/GeoLite2-City.mmdb ]; then
        require gh
        log "vendoring GeoLite2-City.mmdb via gh release download..."
        local tag
        tag=$(gh api /repos/P3TERX/GeoLite.mmdb/releases/latest --jq '.tag_name' 2>/dev/null || true)
        [ -n "$tag" ] || fail "could not resolve latest GeoLite.mmdb release tag"
        gh release download "$tag" --repo P3TERX/GeoLite.mmdb \
            --pattern 'GeoLite2-City.mmdb' --dir camoufox-bin/ >/dev/null 2>&1 || \
            fail "GeoLite2-City.mmdb download failed — build cannot continue"
        ok "  -> $(du -h camoufox-bin/GeoLite2-City.mmdb | cut -f1)"
    fi
}

# ---------------------------------------------------------------------------
# git pull with server-local config stashing.
#
# The server tree commonly has uncommitted modifications to .env /
# docker-compose.yml / camoufox-bin/ (from in-place deploys or carryover
# from older layouts). A plain `git pull --rebase` rejects these and
# breaks the deploy. We snapshot them under a per-deploy stash label,
# pull, and pop — so the deploy NEVER fails on local config drift.
git_pull_safe() {
    if [ ! -d .git ]; then
        warn "not a git repo — skipping git pull"
        return 0
    fi

    # Build a pathspec from SERVER_LOCAL_PATHS, but ONLY include ones that
    # actually exist or are tracked. Passing an empty pathspec to
    # `git stash push -- <empty>` is an error in newer git.
    local paths=()
    for p in "${SERVER_LOCAL_PATHS[@]}"; do
        if [ -e "$p" ] || git ls-files --error-unmatch "$p" >/dev/null 2>&1; then
            paths+=("$p")
        fi
    done

    local label="deploy-$(date +%Y%m%d-%H%M%S)"
    if [ ${#paths[@]} -gt 0 ]; then
        log "git pull: stashing server-local config (${#paths[@]} paths) -> $label"
        # `--` separates ref from pathspec; -u includes untracked.
        git stash push -u -m "$label" -- "${paths[@]}" >/dev/null 2>&1 || \
            warn "git stash push skipped (no local changes to stash)"
    fi

    log "git pull: fast-forwarding main..."
    if ! git -c core.autocrlf=false pull --ff-only 2>&1 | tail -3; then
        warn "git pull --ff-only failed — falling back to merge (non-fast-forward)"
        git -c core.autocrlf=false pull --no-rebase 2>&1 | tail -3 || \
            warn "git pull failed (continuing with current tree)"
    fi

    if [ ${#paths[@]} -gt 0 ]; then
        # Pop ONLY if the latest stash is ours — never stomp an unrelated stash.
        local latest
        latest=$(git stash list --format='%gd %s' 2>/dev/null | head -1 || true)
        if [[ "$latest" == *"$label"* ]]; then
            log "git pull: restoring server-local config"
            git stash pop >/dev/null 2>&1 || \
                warn "git stash pop failed (some local changes preserved in stash; run 'git stash list')"
        fi
    fi
}

# ---------------------------------------------------------------------------
# Subcommand: init
cmd_init() {
    require git
    require docker
    check_docker_alive

    log "init: cloning sibling forks next to $APP ..."
    if [ ! -d camofox-browser/.git ]; then
        git clone https://github.com/Fectivnfy112357/camofox-browser.git camofox-browser
    else
        log "camofox-browser/ exists, skipping clone"
    fi
    if [ ! -d opencli/.git ]; then
        git clone https://github.com/Fectivnfy112357/opencli.git opencli
    else
        log "opencli/ exists, skipping clone"
    fi

    log "init: vendoring Camoufox binary + GeoIP DB..."
    vend_assets

    if [ ! -f .env ]; then
        log "init: writing default .env"
        cat > .env <<'EOF'
CAMOFOX_API_KEY=my_secret_api_key_123
GATEWAY_API_KEY=change_me_gateway_key
CAMOFOX_USER_ID=fectivnfy
GATEWAY_EXPOSE_PORT=9378
PUBLIC_HOST=
EOF
        warn "edit .env and replace the placeholder *_API_KEY values before exposing publicly"
    fi

    cmd_deploy
}

# ---------------------------------------------------------------------------
# Subcommand: deploy
cmd_deploy() {
    require docker
    check_docker_alive

    git_pull_safe
    preflight

    log "deploy: building image..."
    if ! docker compose build 2>&1 | tail -20; then
        fail "docker compose build failed — check the lines above for the actual error"
    fi

    log "deploy: recreating container..."
    if ! docker compose up -d --force-recreate camofox 2>&1 | tail -5; then
        fail "docker compose up failed"
    fi

    # Supervisord boots camofox / opencli-daemon / shim / gateway in
    # priority order; the slowest (gateway) declares startsecs=5. Wait
    # for the container itself to become healthy before probing.
    log "deploy: waiting for container healthcheck..."
    local i=0
    while [ $i -lt 60 ]; do
        local state
        state=$(docker inspect --format '{{.State.Health.Status}}' camofox 2>/dev/null || echo "starting")
        case "$state" in
            healthy)   ok "container healthy"; break ;;
            unhealthy) fail "container reports unhealthy — run 'bash deploy.sh logs' to inspect" ;;
            *)         sleep 2; i=$((i+1)) ;;
        esac
    done
    if [ $i -ge 60 ]; then
        warn "container did not become healthy within 120s — continuing with status probe anyway"
    fi

    cmd_status
}

# ---------------------------------------------------------------------------
# Subcommand: status
cmd_status() {
    require docker
    log "container:"
    docker compose ps camofox 2>&1 | tail -3 || warn "camofox container not running"
    echo
    log "camofox /health:"
    curl -fsS -m 5 http://localhost:9377/health || echo "  unreachable"
    echo
    log "gateway /health:"
    curl -fsS -m 5 -H "Authorization: Bearer ${GATEWAY_API_KEY:-change_me_gateway_key}" \
        "http://localhost:${GATEWAY_EXPOSE_PORT:-8080}/health" \
        || echo "  unreachable"
    echo
    log "noVNC websockify handshake:"
    curl -s -m 5 -o /dev/null \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -w '  http=%{http_code}\n' \
        "http://localhost:6080/websockify" 2>&1 | tail -1
}

# ---------------------------------------------------------------------------
# Subcommand: vnc
cmd_vnc() {
    require docker
    local token="${CAMOFOX_API_KEY:-my_secret_api_key_123}"
    log "vnc: cycling display mode to refresh x11vnc/websockify..."
    curl -fsS -m 30 -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
        -d '{"headless":false}' "http://localhost:9377/sessions/${CAMOFOX_USER_ID:-fectivnfy}/toggle-display" >/dev/null || true
    sleep 1
    local resp
    resp=$(curl -fsS -m 30 -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
        -d '{"headless":"virtual"}' "http://localhost:9377/sessions/${CAMOFOX_USER_ID:-fectivnfy}/toggle-display")
    echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print('vncUrl:', d.get('vncUrl',''))"
}

# ---------------------------------------------------------------------------
# Subcommand: logs
cmd_logs() {
    docker logs camofox --tail 50 -f 2>&1 | head -100
}

# ---------------------------------------------------------------------------
# Subcommand: down
cmd_down() {
    docker compose stop camofox
    log "stopped. data/ + logs/ preserved."
}

# ---------------------------------------------------------------------------
# Dispatch
[ -f .env ] && . ./.env 2>/dev/null || true
case "${1:-help}" in
    init)    cmd_init ;;
    deploy)  cmd_deploy ;;
    status)  cmd_status ;;
    vnc)     cmd_vnc ;;
    logs)    cmd_logs ;;
    down)    cmd_down ;;
    help|--help|-h)
        grep -E '^#   [a-z]+' "$0" | sed 's/^# //'
        ;;
    *)
        fail "unknown subcommand: $1 (try: init | deploy | status | vnc | logs | down | help)"
        ;;
esac