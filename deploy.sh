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
#   deploy     Subsequent updates. `git pull --rebase`, `docker compose
#              build` (cache-aware), then `up -d --force-recreate` and
#              health-probe all four endpoints.
#   vnc        Restart the in-container x11vnc/websockify pair and print
#              a fresh noVNC URL for the user.
#   status     One-shot health summary.
#   logs       Tail supervisord + camofox + gateway logs.
#   down       Stop and remove the container (data/ is preserved).
#
# Conventions:
#   - All paths are relative to this script's directory.
#   - No `pkill docker` / `docker system prune -a` — shared host.

set -euo pipefail

cd "$(dirname "$0")"
APP="$PWD"

# ---------------------------------------------------------------------------
# Helpers
log()   { printf '\033[1;34m[deploy]\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n'   "$*" >&2; }
fail()  { printf '\033[1;31m[fail]\033[0m %s\n'   "$*" >&2; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"
}

check_docker_alive() {
    # Liveness probe only — never kill the daemon.
    docker info >/dev/null 2>&1 || fail "docker daemon unreachable (DO NOT pkill — shared host)"
}

# ---------------------------------------------------------------------------
# Shared assets: ensure camofox-bin/ has Camoufox binary + GeoIP DB.
vend_assets() {
    mkdir -p camoufox-bin

    # Camoufox binary — latest release tag.
    if [ ! -s camoufox-bin/camoufox-bin.zip ]; then
        require gh
        gh auth status >/dev/null 2>&1 || fail "gh not authenticated — run \`gh auth login\` first"
        log "downloading Camoufox binary via gh release download..."
        local tag
        tag=$(gh api /repos/daijro/camoufox/releases/latest --jq '.tag_name')
        [ -n "$tag" ] || fail "could not resolve latest Camoufox release tag"
        gh release download "$tag" --repo daijro/camoufox \
            --pattern "camoufox-*-lin.x86_64.zip" \
            --dir camoufox-bin/ >/dev/null
        local zip
        zip=$(ls camoufox-bin/camoufox-*-lin.x86_64.zip 2>/dev/null | head -1)
        [ -n "$zip" ] || fail "no camoufox-*-lin.x86_64.zip downloaded"
        mv "$zip" camoufox-bin/camoufox-bin.zip
        log "Camoufox binary -> camoufox-bin/camoufox-bin.zip ($(du -h camoufox-bin/camoufox-bin.zip | cut -f1))"
    fi

    if [ ! -s camoufox-bin/version.json ]; then
        require gh
        log "writing version.json sidecar..."
        local camoufox_tag="v152.0.4-beta.28"
        printf '{"version":"152.0.4","release":"%s"}' "$camoufox_tag" > camoufox-bin/version.json
    fi

    if [ ! -s camoufox-bin/GeoLite2-City.mmdb ]; then
        require gh
        log "downloading GeoLite2-City.mmdb via gh release download..."
        local tag
        tag=$(gh api /repos/P3TERX/GeoLite.mmdb/releases/latest --jq '.tag_name')
        [ -n "$tag" ] || fail "could not resolve latest GeoLite.mmdb release tag"
        gh release download "$tag" --repo P3TERX/GeoLite.mmdb \
            --pattern 'GeoLite2-City.mmdb' --dir camoufox-bin/ >/dev/null
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

    log "deploy: pulling latest code..."
    if [ -d .git ]; then
        git -c core.autocrlf=false pull --rebase 2>&1 | tail -3 || warn "git pull failed (continuing with current tree)"
    else
        warn "not a git repo — skipping git pull"
    fi

    log "deploy: building image..."
    docker compose build 2>&1 | tail -10

    log "deploy: recreating container..."
    docker compose up -d --force-recreate camofox 2>&1 | tail -5

    sleep 8  # supervisord boot

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
