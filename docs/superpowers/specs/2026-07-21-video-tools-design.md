# Camofox-OpenCLI Video Tools Design

**Date:** 2026-07-21
**Status:** Approved (brainstorming)
**Scope:** Two new MCP tools (`video_search`, `video_download`) registered on the gateway alongside existing content tools.

## Goal

Add two MCP tools that let an agent find videos across multiple platforms and download them, without forcing the caller to know which OpenCLI subcommand to invoke per site.

- `video_search(query, platform?, limit?)` — search videos across 1–N sites in parallel, return unified results.
- `video_download(urls[], quality?)` — download 1–3 videos to a temp file inside the container, return a temporary HTTPS URL the client can `curl`/`GET` to fetch the bytes.

Both tools run inside the existing gateway process (`gateway/src/`) on port 8080. No new Docker ports, no new deployment files.

## Non-Goals

- Streaming the video bytes directly through MCP (avoids base64 context blow-up).
- Adding new adapters to OpenCLI — we reuse existing `bilibili download`, `instagram download`, plus a `yt-dlp` fallback for everything else.
- Persisting downloaded videos across container restarts (1-hour TTL only).
- Authentication on the file-fetch endpoint (unguessable UUIDs act as capability URLs).

## Architecture

```
            MCP client (Claude Code / other)
                          │ JSON-RPC /mcp
                          ▼
┌──────────────────────────────────────────────────────────────┐
│              gateway :8080  (Node/TS)                         │
│                                                               │
│  ┌─────────────┐    ┌────────────────┐    ┌──────────────┐  │
│  │ video_search │───▶│  VideoRouter   │───▶│ opencli      │  │
│  │  tool        │    │  - platform    │    │ search tool  │  │
│  └─────────────┘    │    parse       │    │ (existing)   │  │
│                     │  - semaphore=3 │    └──────────────┘  │
│  ┌──────────────┐   │  - result      │                       │
│  │ video_download│──▶│    unify       │    ┌──────────────┐  │
│  │  tool        │    └────────────────┘    │ CookieInject │  │
│  └──────────────┘            │            │ (new)        │  │
│         │                    │            └──────┬───────┘  │
│         ▼                    ▼                   │          │
│  ┌─────────────┐    ┌────────────────┐           │          │
│  │ DownloadPool│───▶│ TempStore      │◀──────────┘          │
│  │ 3 workers   │    │ ./tmp/video_*  │                      │
│  └─────────────┘    │ + GET /files/* │                      │
│         │           └────────────────┘                      │
│         ▼                                                   │
│  ┌─────────────────────────┐                                │
│  │ NativeDispatcher        │ → opencli bilibili download    │
│  │ (sniff URL → route)     │ → opencli instagram download   │
│  └─────────────────────────┘                                │
│         │ fallback                                          │
│         ▼                                                   │
│    yt-dlp --cookies /tmp/cookies_<host>.txt                  │
└──────────────────────────────────────────────────────────────┘
```

### Modules (all in `gateway/src/`)

1. **`video-router.ts`** — Parses the `platform` argument (single name, "all", or omitted → default 3-site list), fans out to OpenCLI's existing `search` tool per platform, runs them under a 3-slot semaphore, and merges results into one unified schema.
2. **`video-cookies.ts`** — Calls Camofox's `GET /sessions/:userId/cookies`, filters by target URL host, writes a Netscape-format cookie file at `/tmp/camofox_cookies_<host>.txt` for `yt-dlp --cookies`.
3. **`download-pool.ts`** — 3-worker FIFO queue. Each job picks `native` or `ytdlp` from `NativeDispatcher`, runs it as a child process, captures stdout/stderr to a per-job log file, and registers the output file with `TempStore`.
4. **`native-dispatcher.ts`** — URL → (platform, method, args). Recognizes bilibili/b23.tv → `opencli bilibili download --bvid <id>`; instagram/instagr.am → `opencli instagram download --url <url>`; everything else → yt-dlp. Extracts IDs via simple regex on the URL path.
5. **`temp-store.ts`** — In-memory map of `{id → {path, filename, size_bytes, created_at, expires_at}}`. `register(path)` returns a UUID. `get(id)` resolves to the file path. `sweep()` deletes files whose `mtime > 1h`. Background `setInterval(sweep, 10*60*1000)`. On boot, also runs `sweep()` once.
6. **`video-types.ts`** — Shared TS types: `VideoSearchResult`, `VideoDownloadResult`, error codes.

### Modified files

- **`gateway/src/mcp.ts`** — Register the two new tools via `server.registerTool(...)`. Each takes a zod schema and delegates to the relevant module.
- **`gateway/src/rest.ts`** — Add `GET /files/:id` route. No auth. Streams the file via `fs.createReadStream`, sets `Content-Type: video/mp4` (or sniffed mime), `Content-Disposition: attachment; filename="<original>"`. 404 if missing/expired.

### New dependencies

- `yt-dlp` — installed system-wide in the container via `pip install yt-dlp` in the Dockerfile stage that already pulls Python tooling (or a dedicated `apt-get install yt-dlp` if packaged). Must be on `PATH` for the gateway process.

## MCP Tool Schemas

### `video_search`

```ts
input: {
  query: string,                              // required, non-empty
  platform?: string,                          // see "Platform resolution" below
  limit?: number,                             // default 10, max 30
}
output: {
  results: Array<{
    platform: string,                         // e.g. "bilibili"
    id: string,                               // platform-native ID (e.g. "BV1xxx")
    title: string,
    url: string,                              // canonical URL the download tool accepts
    author?: string,
    duration?: string,                        // "10:23"
    views?: number,
    thumbnail?: string,
  }>,
  stats: {
    requested_platforms: string[],
    succeeded: string[],
    failed: Array<{ platform: string, error: string }>,
  }
}
```

### `video_download`

```ts
input: {
  urls: string[],                             // required, length 1–3
  quality?: "best" | "1080p" | "720p" | "480p" | "worst",  // default "best"
}
output: {
  results: Array<
    | {
        url: string,                          // original input URL
        ok: true,
        method: "native" | "ytdlp",
        filename: string,                     // e.g. "BV1xxx.mp4"
        size_bytes: number,
        download_url: string,                 // absolute URL, see "Download URLs" below
        expires_at: string,                   // ISO 8601
      }
    | {
        url: string,
        ok: false,
        error_code: ErrorCode,
        error_message: string,
      }
  >
}
```

## Platform Resolution (video_search)

| `platform` value | Platforms searched |
|---|---|
| omitted | `["bilibili", "youtube", "douyin"]` (the 3 that work without login) |
| `"all"` | All 8 supported sites |
| one of the 8 names | Just that one site |
| anything else | `INVALID_PLATFORM` error |

Supported sites (8): `bilibili`, `youtube`, `douyin`, `tiktok`, `instagram`, `xiaohongshu`, `weibo`, `twitter`.

## Data Flow

### `video_search`

1. Parse arguments. Empty `query` → `EMPTY_QUERY`. Unknown `platform` → `INVALID_PLATFORM`.
2. Resolve the platform list per the table above.
3. Acquire a 3-slot semaphore (Node `Promise` pool or a tiny custom `Semaphore`). Each acquired slot invokes `runOpencli(site, "search", { query, limit })` and maps the OpenCLI row to the unified schema (best-effort field mapping per site).
4. Collect all results into the `results` array. Per-site failures land in `stats.failed`, not as thrown errors.
5. Return within a single MCP response (no streaming).

### `video_download`

1. Validate `urls.length ∈ [1, 3]`. Each URL must be `http://` or `https://`. Bad URL → `INVALID_URL` for that index only; the other URLs still proceed.
2. For each URL, enqueue a job in `DownloadPool` (3-worker queue, so jobs beyond 3 wait).
3. Each job:
   a. `NativeDispatcher.route(url)` → `{ method: "native"|"ytdlp", cmd, args }`.
   b. `method === "native"`:
      - Spawn `opencli <site> download <args...>` via the existing `runOpencli`.
      - On non-zero exit → fall back to `ytdlp` for that URL.
   c. `method === "ytdlp"`:
      - Filter cookies for the URL's host (or empty file if Camofox is unreachable).
      - Spawn `yt-dlp --cookies <file> -o <temp_template> -f <quality> <url>` with `--no-warnings --no-playlist`.
      - Retry once on transient errors (network reset / 5xx) after 2s.
   d. On success: locate the output file in `./tmp/`, call `TempStore.register(path)` to mint a UUID and capture size.
   e. Build the absolute `download_url` from the inbound `Host` / `X-Forwarded-Host` header (see "Download URLs" below).
4. Collect per-URL outcomes into `results`. The MCP response returns once every job has resolved (bounded by `WORKER_TIMEOUT`, see Errors).

### Download URLs

The MCP client receives:

```
"download_url": "https://textvision.top:8080/files/<uuid>.mp4"
```

Construction rules:
- Scheme is taken from the inbound request (`req.protocol` when behind TLS-terminating proxy, else `http`).
- Host comes from `X-Forwarded-Host` (if present), else `Host` header.
- Port comes from `X-Forwarded-Port` (if present), else the host header's port.

The gateway then exposes:

```
GET /files/:id
```

- No auth (UUID is unguessable).
- Streams the file with `Content-Type` from a quick mime sniff (`.mp4`, `.webm`, `.mkv`).
- `Content-Disposition: attachment; filename="<original>.mp4"`.
- 404 on missing/expired id.
- The route is registered in the same HTTP server as the existing REST routes; no separate listener.

## Error Handling

| Code | When | Action |
|---|---|---|
| `INVALID_URL` | URL not http/https, or URL parse failed | per-URL error in `results` |
| `URLS_TOO_MANY` | `urls.length > 3` | full request rejected |
| `EMPTY_QUERY` | `query` empty after trim | full request rejected |
| `INVALID_PLATFORM` | `platform` not in the 8 supported names or `"all"` | full request rejected |
| `NATIVE_DOWNLOAD_FAILED` | opencli download non-zero exit | auto-fallback to `ytdlp`; only surfaces if `ytdlp` also fails |
| `YT_DLP_FAILED` | yt-dlp exit non-zero after retry | per-URL error; include stderr truncated to 500 chars |
| `COOKIE_FETCH_FAILED` | Camofox cookies endpoint unreachable | yt-dlp runs without cookies once; if it then succeeds, return `ok`; else bubble `YT_DLP_FAILED` |
| `LOGIN_REQUIRED` | platform rejected with login error code | per-URL error; message hints to use the existing `login` tool |
| `PAID_CONTENT` | bilibili paid-content pre-check (if routed via native) | per-URL error; message mentions `--force` |
| `RATE_LIMITED` | platform 429 / known anti-bot block | yt-dlp retries with 2s / 8s backoff; final failure → `RATE_LIMITED` |
| `WORKER_TIMEOUT` | job exceeds 10 min | kill the child process, mark as timeout |
| `DISK_FULL` | write fails with `ENOSPC` | immediate fail; suggest `TempStore.sweep()` |

Single-point failures never abort the whole request. `video_search` collects per-site failures in `stats.failed`. `video_download` collects per-URL failures in `results[i].ok=false`.

## Concurrency Limits

- `video_search`: 3-site semaphore regardless of `platform=all`. All 8 sites are *attempted*, but at most 3 run at once.
- `video_download`: 3-worker pool. A 3-URL request starts all 3 immediately. A request with 1 URL just uses 1 slot.

## Temp File Lifecycle

- Files live in `${GATEWAY_TMP_DIR:-./tmp}/video_<uuid>.<ext>`.
- Bind-mounted to host `${GATEWAY_TMP_HOST_DIR:-./data/gateway-tmp}` (new volume in `docker-compose.yml`). The host dir is what gets pruned if disk pressure ever appears.
- TTL: 1 hour from `register()`. Background sweep every 10 minutes (`setInterval`).
- Sweep rule: any `./tmp/video_*` file whose `mtime > 1h` is removed. Other `./tmp/*` is untouched.
- Boot sweep: same rule runs once at process start.

## Tests

### Unit (`vitest` in `gateway/`)

- `video-router.test.ts` — platform parsing (omitted / "all" / single / unknown), semaphore behavior under N=10 jobs, result-shape mapping per platform with mock `runOpencli`.
- `video-cookies.test.ts` — Netscape writer format compliance; host filter excludes other-domain cookies; missing Camofox session yields empty file.
- `native-dispatcher.test.ts` — URL fixtures: bilibili `bvid`, bilibili short `b23.tv`, instagram `/p/`, `/reel/`, `/tv/`, youtu.be, x.com, generic m3u8 → method/args resolution.
- `temp-store.test.ts` — register/get round-trip; sweep removes expired files; sweep keeps non-`video_*` files; missing id returns undefined.
- `download-pool.test.ts` — queue depth, 3-worker fan-out, child failure propagation.

### Integration (mocked HTTP)

- `video-search.integration.test.ts` — mock `runOpencli` for 4 platforms, 1 forced to fail; assert 3 in `results`, 1 in `stats.failed`, total response shape.
- `video-download.integration.test.ts` — mock a fake `yt-dlp` that writes `./tmp/fake.mp4`; assert `download_url` resolves to a 200 streaming response.

### Live smoke (manual)

- `video_search("lofi hip hop", platform="all")` — assert 3 sites return real results within 10 s.
- `video_search("minecraft", platform="youtube")` — assert yt-search-equivalent results land via OpenCLI's `youtube search`.
- `video_download([...3 short clips...])` — assert 3 temp URLs, each GETs back a valid MP4 header.
- `video_download([invalid URL + 2 valid])` — assert 1 error + 2 successes.
- TTL: re-register a file with synthetic mtime > 1 h, trigger `sweep()`, assert file gone.

### MCP smoke

- Through `/mcp` with a real MCP client, call both tools. Assert JSON-RPC envelopes match schema and no errors.

## Deployment / Runbook

- No new Docker ports, no new compose services, no new env vars beyond an optional `GATEWAY_TMP_DIR` (defaults to `./tmp`).
- `yt-dlp` is added to the existing runtime image (`apt-get install -y yt-dlp` or `pip install --break-system-packages yt-dlp`).
- Bind-mount `./data/gateway-tmp:/opt/gateway/tmp` added to `docker-compose.yml` so temp files survive `up --build` cache invalidations. Pre-existing `./data/cookies` mount stays untouched.
- On the server, the nginx config in front of the gateway needs one new `location /files/ { proxy_pass http://gateway:8080; }` block. One-time manual edit; not part of the spec's automated deployment.

## Open Questions (left for implementation)

- Should `video_search` deduplicate results across platforms (same video posted to two sites)? Current design says no; first occurrence wins. Revisit if users complain.
- Should `quality="best"` map to a specific `yt-dlp -f` selector (e.g. `bv*+ba/b`) or leave it at yt-dlp's default? Default for now.
- Camofox cookie fetch — should we surface a "login required" hint when the Camofox session for the target host has zero cookies? Useful but optional.
- `instagram download` currently only supports `/p/<shortcode>/`, `/reel/<shortcode>/`, `/tv/<shortcode>/` URL shapes — should the dispatcher reject other shapes upfront, or rely on the OpenCLI command to error? Currently designed to let OpenCLI error.
- The `xiaohongshu` and `twitter` platform searches both require login. When a logged-out session hits them, the existing OpenCLI search returns `AUTH_REQUIRED`. Spec treats that as a per-site failure landing in `stats.failed`; callers can then run `login` and retry. No special handling added.

## Related Memories / Files

- `gateway/src/mcp.ts` — registration site.
- `gateway/src/rest.ts` — `/files/:id` registration site.
- `gateway/src/opencli.ts` — existing `runOpencli()` to wrap.
- `gateway/src/dev-mock.ts` — pattern for mock-mode tests.
- `CLAUDE.md` — gateway quirks (`--timeout 30` injection, per-request `ctx`).