# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Camofox Shim bridges **OpenCLI** (a forked CLI with 100+ platform adapters: xiaohongshu, X/Twitter, bilibili, Reddit…) to the **Camofox** anti-detection browser (Firefox fork). It lets OpenCLI's adapters run unchanged against Camofox instead of Chrome.

It impersonates a Chrome Extension, translating OpenCLI daemon commands into Camofox REST API calls.

## Commands

```bash
npm run build     # tsc → dist/   (both shim src/ and gateway/)
npm run dev       # tsx src/index.ts (run shim TS directly, no build)
npm start         # node dist/index.js (requires build first)
```

Gateway lives in `gateway/` (own `package.json`, own tests):
```bash
cd gateway
npm install                    # one-time
npx vitest run                 # 52 tests
npm run build                  # tsc → gateway/dist/
GATEWAY_MANIFEST=../../opencli/cli-manifest.json \
  GATEWAY_API_KEY=dev node dist/index.js   # smoke run
```

No root-level linter is configured.

## Architecture (v3 — Shim + Gateway + MCP)

Three components in one Docker container (`camofox-opencli/`, built by monorepo `Dockerfile`):

1. **Camofox Shim** (`src/`, Node/TS) — WebSocket *client* mode. Connects to OpenCLI daemon's `/ext` endpoint, impersonates a Chrome Extension, translates OpenCLI `DaemonCommand` to Camofox REST API calls. **Does NOT listen on any port** (the daemon owns 19825; v1 HTTP-server mode was abandoned).
2. **Gateway** (`gateway/`, Node/TS) — single process exposing opencli to external agents: REST + built-in MCP streamable HTTP on `:8080`. Spawns `opencli <site> <command> --format json`, parses YAML/JSON envelopes.
3. **OpenCLI** (sibling submodule, `../opencli/`) — 100+ platform adapters + daemon.

```
CLI → daemon(:19825) → WS /ext → Shim → Camofox(:9377)
                                  ▲
external agent ── REST/MCP ───────┘ (gateway :8080)
```

### Shim (`src/`)
- `index.ts` — WS client. Connects to `OPENCLI_DAEMON_WS`, sends `hello`, pings every 15s, auto-reconnects after 3s. Dispatches `{id, action}` to translator.
- `translator.ts` — `translateCommand()` maps `DaemonCommand.action` to Camofox calls. `UNSUPPORTED` set returns `unsupported_backend` for genuinely-impossible commands (`cdp`, `frames`, `wait-download`, `set-file-input`). **`network-capture-start/read` return success + empty data** so that `opencli browser open/click/navigate` (which eagerly call `startNetworkCapture`) complete their goto instead of failing.
- `translator.ts` **self-heal**: when any handleXxx throws "Tab not found" / "target id not found" / "page not found", it drops the stale session mapping, rebuilds via `session.restoreFromLastUrl()`, and retries the command once with `retriedAfterSessionRestore=true` (loop guard).
- `session.ts` — In-memory `Map<sessionId, SessionMapping>` of `OpenCLI sessionId → (userId, tabId, lastUrl)`. `restoreFromLastUrl()` recreates a Camofox tab and navigates back to the recorded `lastUrl` after silent tab loss (manual VNC login, IDLE_TIMEOUT eviction).
- `camofox-client.ts` — Thin `fetch()` wrapper over Camofox REST. 120s default timeout, optional `Bearer` from `CAMOFOX_API_KEY`.
- `types.ts` — `DaemonCommand`/`DaemonResult` (OpenCLI side) + `Camofox*` types.

### Gateway (`gateway/src/`)
- `index.ts` — HTTP server. `/mcp` creates a **fresh `McpServer` + `StreamableHTTPServerTransport` per request** (stateless mode). Previously reused a single transport across concurrent requests, causing JSON-RPC stream interleaving and intermittent failures that tripped Claude Code's MCP circuit breaker (3 consecutive failures → ~37-60s cooldown).
- `mcp.ts` — 16 tools: `list_sites`, `site_help`, `run_command`, `browser`, `login`, `doctor`, plus 10 primary site commands (`PRIMARY_SITES`). Host from inbound `Host` / `X-Forwarded-Host` is passed via per-request `ctx` (no global mutable host).
- `logger.ts` — Structured JSONL logger to `GATEWAY_LOG_DIR/gateway.log` (default `/var/log/gateway`) + stdout mirror. Write failures degrade silently to stdout-only.
- `opencli.ts` — `runOpencli()` spawns `opencli <site> <command> --format json`; `parseResult()` handles strict JSON / YAML envelope / stderr-JSON fallback.
- `rest.ts` — REST routes (`/health`, `/sites`, `/sites/:site/help`, `/run`, `/login`) with `GATEWAY_API_KEY` Bearer auth.
- `manifest.ts` — Loads `cli-manifest.json` (~1277 records / 173 sites) for command discovery.
- `camofox-login.ts` — Toggle-display VNC login flow.

### MCP tool quirks (worth knowing)
- **`<site> login` default timeout**: gateway injects `--timeout 30` when caller omits it (avoids the 300s default lock that ties up MCP clients while waiting for VNC manual login). User-supplied `args.timeout` wins.
- **`browser.positional` quirk**: Claude Code's MCP tool UI cannot populate top-level array fields. Values land in `args.positional` instead; the handler hoists them into argv positionals. Callers can pass either form (`positional: ["url"]` or `args: {positional: "url"}`).
- **`browser.open` is `page.goto` under the hood**: requires `positional: ["https://..."]` to be passed; empty positional → "missing required argument 'url'".
- **`browser.positional` accepts `null`** so callers omitting it don't trigger zod validation errors.

### Cookies quirk
`handleCookies` prefers `GET /sessions/:userId/cookies` (Camofox fork's ~20-line endpoint, HttpOnly via Playwright context). Falls back to `document.cookie` via `evaluate` (no HttpOnly) when unavailable.

### Adding a new command
- Shim: add `case` in `translator.ts` dispatch, implement `handleX()` resolving session via `session.ensureTab()` / `restoreFromLastUrl()`, call `camofox.*` from `camofox-client.ts`.
- Gateway: no change needed if it's in the manifest (`/run` and `run_command` both auto-handle it). Only `PRIMARY_SITES` in `mcp.ts` is hand-curated.

## Gateway

Single Node/TS process inside the container on `:8080` exposing both REST and MCP (`streamable HTTP /mcp`):

- **Auth**: `GATEWAY_API_KEY` Bearer on all routes except `GET /health`; `/mcp` is also guarded.
- **REST**: `GET /health`, `GET /sites?q=`, `GET /sites/:site/help`, `POST /run {site,command,args}`, `POST /login {url?}` → `{vncUrl}`.
- **MCP**: generic `list_sites/site_help/run_command/browser/login/doctor` + 10 primary site tools. Other ~160 sites via progressive disclosure. Uses SDK `registerTool` + zod v4.
- **Skill**: `skills/opencli-camofox/` — stdlib-only Python scripts (`_client.py` + helpers) calling the gateway over HTTP. Config via `OPENCLI_GATEWAY_URL` + `GATEWAY_API_KEY` (or `~/.opencli-gateway.env`).

## Deployment

`Dockerfile` (in monorepo root `camofox-opencli/`) expects sibling dirs `opencli/`, `camofox-shim/`, `camofox-browser/` — **not built from this repo alone**. Stage 1 builds OpenCLI, stage 2 builds this shim, stage 3 layers both onto `ghcr.io/redf0x1/camofox-browser:latest`.

Sibling project paths (all under `../`):
- `../opencli/` — forked OpenCLI CLI (100+ platform adapters + daemon).
- `../camofox-browser/` — forked Camofox browser (adds `GET /sessions/:userId/cookies`).
- `../camofox-opencli/` — deployment root (Dockerfile, docker-compose, supervisord, this shim as a submodule).

Known base-image issue: the base image's `server.js` is ESM but its `package.json` declares commonjs, so Camofox is launched via the compiled `dist/src/server.js` through `entrypoint-camofox.sh`.

```bash
docker compose up --build   # exposes 9377 (REST), 6080 (VNC), 19825 (daemon), 8080 (gateway)
```

### Server-side deploy script
The aggregate repo ships `deploy.sh` (root of `camofox-opencli/`). On the server:
```bash
cd /www/dk_project/dk_app/camofox-opencli
git pull && ./deploy.sh
```
`deploy.sh` does: pull → sync submodule → `docker compose build` (only when source hash changed) → `up -d` → health-check + 8-way concurrent `/health` probe + tail the on-host gateway logs. Supports `--no-build` (fast restart) and `--logs` (tail after deploy).

### Gateway logs
The container logs `/var/log/gateway/{gateway.log, supervisor-stdout.log, supervisor-stderr.log}` are bind-mounted to `${GATEWAY_LOG_HOST_DIR:-./logs/gateway}` on the host (configured in `docker-compose.yml`). The bind-mount is `chown`'d to the `node` user by an `entrypoint.sh` wrapper that runs as root before exec'ing supervisord — without this, the bind mount comes up root-owned and the gateway (running as `node`) cannot write its JSONL file.
