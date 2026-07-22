# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

camofox-opencli is a self-contained Docker image (3 processes in 1 container) that runs the **Camofox anti-detection browser** alongside an **MCP/REST gateway** exposing the OpenCLI CLI's 100+ site adapters (xiaohongshu, X/Twitter, bilibili, Reddit…) plus a video download subsystem backed by yt-dlp.

Two interfaces, one process tree:

```
external agent ── REST/MCP ───► :8080  gateway (Node/TS, MCP streamable HTTP)
                                       │
                                       │ spawns opencli <site> <cmd>
                                       ▼
                                   opencli daemon (:19825 WS)
                                       │
                                       │ daemon dispatches via /ext
                                       ▼
                                   shim (Node/TS, WebSocket client)
                                       │
                                       │ /tabs, /sessions/:uid/cookies, …
                                       ▼
                                   Camofox browser (:9377)
```

The shim is *not* an HTTP server — it speaks the Chrome Extension WS protocol to the opencli daemon (`/ext` endpoint), translating `DaemonCommand` actions to Camofox REST calls. This lets every opencli adapter run unmodified against Camofox instead of Chrome.

## Commands

```bash
npm run build       # tsc → dist/   (both shim and gateway src/)
npm run dev         # tsx src/shim/index.ts (run shim TS directly)
npx vitest run      # 114 tests
```

No root-level linter is configured.

## Architecture (single package, two subpackages)

Three Node/TS components inside one container, plus the Camofox browser fork:

1. **Camofox** (`/opt/camofox/`, contributed by the `camofox-browser` sibling repo) — Firefox fork with a custom `GET /sessions/:userId/cookies` endpoint. Entry: `node --max-old-space-size=128 dist/src/server.js`. Port 9377.
2. **opencli-daemon** (`/opt/opencli/`) — the upstream CLI's WebSocket daemon on port 19825. Drives 100+ site adapters.
3. **shim** (`dist/shim/`, in this repo) — WebSocket *client* mode. Connects to `OPENCLI_DAEMON_WS`, impersonates a Chrome Extension, translates `DaemonCommand` to Camofox REST calls. **No port of its own.**
4. **gateway** (`dist/gateway/`, in this repo) — HTTP server on port 8080. Auth via `GATEWAY_API_KEY` Bearer. Single `McpServer` + `StreamableHTTPServerTransport` created per request (stateless) — see the "MCP tool quirks" note on why.

Single `package.json`, single `tsconfig.json` with `rootDir=src`. tsc emits `dist/shim/*` and `dist/gateway/*` mirroring src/. Supervisord orchestrates all four processes (see `supervisord.conf`).

### Shim (`src/shim/`)
- `index.ts` — WS client. Connects to `OPENCLI_DAEMON_WS`, sends `hello`, pings every 15s, auto-reconnects after 3s. Dispatches `{id, action}` to translator.
- `translator.ts` — `translateCommand()` maps `DaemonCommand.action` to Camofox calls. Self-heals: when any handler throws "Tab not found", drops the stale session, rebuilds via `session.restoreFromLastUrl()`, and retries once with `retriedAfterSessionRestore=true`.
- `session.ts` — In-memory `Map<sessionId, {userId, tabId, lastUrl}>`. Tracks Camofox tabs that opencli spawned so we can navigate them back after IDLE eviction.

### Gateway (`src/gateway/`)
- `mcp/index.ts` — HTTP server. `/mcp` creates a **fresh `McpServer` + `StreamableHTTPServerTransport` per request** (stateless mode). JSON-RPC stream interleaving with a shared transport breaks Claude Code's MCP circuit breaker.
- `mcp/mcp.ts` — site-content tools (`list_sites`, `site_help`, `run_command`, `search`, `login`, `doctor`, `video_search`, `video_download`, plus 10 primary site commands in `PRIMARY_SITES`). Browser primitives are NOT exposed over MCP.
- `video/` — yt-dlp pool. See "Video subsystem" below.
- `core/opencli.ts` — `runOpencli()` spawns `opencli <site> <command> --format json`.
- `core/config.ts` — Loads from env. New fields beyond port/apiKey/manifest: `proxyUrl`, `cookieDir`, `outputDir`.
- `core/manifest.ts` — Loads `cli-manifest.json` (~1277 records / 173 sites).
- `api/rest.ts` — `/health`, `/sites`, `/sites/:site/help`, `/run`, `/login`, `/files/:id`.

### MCP tool quirks (worth knowing)
- **`<site> login` default timeout**: gateway injects `--timeout 30` when caller omits it (avoids the 300s default lock that ties up MCP clients waiting for VNC manual login).
- **browser.positional quirk**: handlers accept both `positional: [...]` and `args: { positional: "url" }` because Claude Code's MCP UI cannot populate top-level array fields.

### Cookies quirk
`video-cookies.ts` prefers `GET /sessions/:userId/cookies` (Camofox's HttpOnly endpoint) and falls back to `document.cookie` via `evaluate`. `wakeBrowser` is invoked when cookies return 409 (idle timeout).

## Video subsystem

The gateway exposes two MCP tools for video: `video_search` and `video_download`. Both fan out via the opencli daemon, but the actual download path is yt-dlp, not the per-site native downloaders.

### `video_search`
Accepts `query`, `platform` (optional), `limit` (optional, default 10, max 30).

- `platform` omitted → bilibili, youtube, tiktok (DEFAULT_PLATFORMS).
- `platform="all"` → all 8 sites: bilibili, youtube, douyin, tiktok, instagram, xiaohongshu, weibo, twitter.
- `platform="<site>"` → just that one.
- Up to 3 sites queried in parallel; per-site failures land in `stats.failed` without aborting the request.

### `video_download`
Accepts `urls` (1-3) and `quality` (optional, default "best" = bv*+ba/b). The legacy "platform" parameter is gone — all routes use yt-dlp uniformly.

For each URL:
1. Fetch cookies for the URL's host from `/sessions/<userId>/cookies` via the Camofox endpoint.
2. Write a Netscape-formatted cookie file at `<cookieDir>/camofox_cookies_<host>.txt`.
3. Spawn `yt-dlp` with `--cookies <cookieFilePath>`, `--proxy <cfg.proxyUrl>`, the chosen format selector, and `-o <outputDir>/video_<uuid>.%(ext)s`.
4. Register the resulting file with `TempStore` and return a `/files/<id>.<ext>` URL with 1-hour TTL.

### Why two host bind-mounts (cookieDir vs outputDir)

Decoupling matters:

- `./data/download → /opt/gateway/tmp`: downloaded video files (visible on the host).
- `./data/cookies → /opt/gateway/cookies`: per-request Netscape cookie staging files (also visible on the host for debugging). Kept in its own directory so users don't accidentally treat cookies as videos.

Both env vars are read from `GATEWAY_OUTPUT_DIR` / `GATEWAY_COOKIE_DIR` in `docker-compose.yml`. Defaults baked into Config: `/opt/gateway/tmp` and `/opt/gateway/cookies`.

### Proxy forwarding

`Config.proxyUrl` is built from `PROXY_HOST` + `PROXY_PORT` env (matching docker-compose's `host.docker.internal:20172` v2raya). When set, every yt-dlp invocation gets `--proxy <url>` so traffic exits the v2raya tunnel rather than the bare container IP — necessary for sites that block non-China IPs (YouTube, TikTok, Twitter/X, Weibo, etc.) when the host's egress IP is in a blacklisted region.

### EJS challenge solver

Built into the image via `pip install yt-dlp-ejs` during `Dockerfile.publish` Stage 4 (alongside `yt-dlp>=2026.7.0`) and Deno for the JS runtime. **No GitHub fetch on first download** — the wheel bundles the solver modules.

If you change yt-dlp version or the deno install, both are pinned in `Dockerfile.publish` and the resulting image only updates on `v*` tag push.

## Deployment

The image is published to **ghcr.io/fectivnfy112357/camofox-opencli** (latest + version tag) by `.github/workflows/publish.yml` triggered on every `v*` tag. `Dockerfile.publish` is a 4-stage BuildKit build that clones `camofox-browser` and `opencli` from their sibling repos via named BuildKit contexts (no submodules in CI).

Local `docker-compose.yml` defaults to `ghcr.io/fectivnfy112357/camofox-opencli:latest` (build block commented out). Mounted host directories:

```yaml
volumes:
  - ./data:/home/node/.camofox           # browser profiles, login state
  - ./data/log:/var/log/gateway          # JSONL + supervisor stderr/stdout
  - ./data/download:/opt/gateway/tmp     # downloaded videos
  - ./data/cookies:/opt/gateway/cookies  # per-request cookie staging
```

### Deploying a code change

The repo has two deployment speeds:

**Slow (CI, ~7 min):** commit, push, tag with `vX.Y.Z`, push tag. CI builds, pushes to ghcr, server pulls via `docker compose pull camofox && docker compose up -d --force-recreate camofox`. Use this for changes that need to be in the published image (Dockerfile, new deps, fixes that ship to other users).

**Fast (scp into container, seconds):** commit + push first, then `npm run build` locally, `scp dist/<changed>.js` to host, `docker cp` into the running container, kill the affected process so supervisord's autorestart picks up the new bytes. Cookie of the gateway lives at `/opt/gateway/...` in the image. **Caveat**: if you then `docker compose pull && up -d --force-recreate`, the image layer overwrites your docker cp'd files. The next CI build + pull will restore your new code.

### Configuration

Key `.env` / docker-compose env:
- `GATEWAY_API_KEY` — required Bearer on `/mcp`, `/sites/*`, `/run`, `/login`, `/files/:id`
- `CAMOFOX_USER_ID=fectivnfy` — which logged-in browser profile the gateway uses for cookies (`GET /sessions/fectivnfy/cookies`)
- `GATEWAY_OUTPUT_DIR=/opt/gateway/tmp` (bind-mount of `./data/download`)
- `GATEWAY_COOKIE_DIR=/opt/gateway/cookies` (bind-mount of `./data/cookies`)
- `PROXY_HOST` / `PROXY_PORT` (host.docker.internal:20172) — used by `cfg.proxyUrl` to forward yt-dlp through v2raya
- `NAVIGATE_TIMEOUT_MS=90000` — VNC pages over the v2raya tunnel can take 30-45s to render
