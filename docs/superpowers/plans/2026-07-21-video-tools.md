# Camofox-OpenCLI Video Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two MCP tools (`video_search`, `video_download`) plus a `GET /files/:id` route to the camofox-opencli gateway so agents can search videos across 8 platforms and download 1-3 videos at a time to short-lived temp files.

**Architecture:** Six small new modules (`video-router`, `video-cookies`, `native-dispatcher`, `download-pool`, `temp-store`, `video-types`) all under `gateway/src/video/`. Two existing files modified (`mcp.ts` registers the tools; `rest.ts` adds `/files/:id`). One new system dependency (`yt-dlp`) added in the Dockerfile. One bind-mount added in `docker-compose.yml` so temp files survive `up --build`. TDD throughout: each module ships with a `vitest` unit test before implementation.

**Tech Stack:** Node 22 + TypeScript 5.7 (existing), Vitest 2.1 (existing), Zod 4 (existing), `@modelcontextprotocol/sdk` 1.24.3 (existing), `yt-dlp` (new system dep, `apt-get install -y yt-dlp` in Dockerfile).

## Global Constraints

- Node ≥ 22, TypeScript ≥ 5.7, vitest ≥ 2.1 (from `gateway/package.json`).
- All new code in `gateway/src/`. Tests co-located in `gateway/src/<module>.test.ts`.
- No new Docker ports. No new env vars required (an optional `GATEWAY_TMP_DIR` defaults to `./tmp`).
- `yt-dlp` must be on the gateway process `$PATH` inside the container.
- Temp files live at `${GATEWAY_TMP_DIR:-./tmp}/video_<uuid>.<ext>`; bind-mounted to `./data/gateway-tmp` on the host.
- TTL on temp files: 1 hour. Background sweep every 10 minutes (`setInterval`). Boot-time sweep too.
- 3-worker concurrency for both `video_search` (semaphore across sites) and `video_download` (queue across URLs).
- A single failed site/URL never aborts the whole request — per-item failures land in `stats.failed` / `results[i].ok=false`.
- `GET /files/:id` has no auth; UUID is unguessable.
- 9 supported sites: bilibili, youtube, douyin, tiktok, instagram, xiaohongshu, weibo, twitter.
- Default `video_search` platforms (when `platform` is omitted): `["bilibili", "youtube", "douyin"]`.
- `video_download` accepts 1–3 URLs per call.
- `video_download` returns absolute `download_url` constructed from inbound `X-Forwarded-Host` → `X-Forwarded-Port` → `Host` headers.

## File Structure

### New files (all under `gateway/src/video/`)

| File | Responsibility | Lines (target) |
|---|---|---|
| `video-types.ts` | Shared TS types: `VideoSearchResult`, `VideoDownloadResult`, `ErrorCode` union, `VIDEO_SITES` constant, `DEFAULT_PLATFORMS` constant | ~50 |
| `video-router.ts` | Parses `platform` arg, fans out via 3-slot semaphore, maps per-site rows into unified schema | ~150 |
| `video-cookies.ts` | Fetches Camofox cookies, filters by host, writes Netscape file at `/tmp/camofox_cookies_<host>.txt` | ~80 |
| `native-dispatcher.ts` | URL → `{method: "native"\|"ytdlp", cmd, args}`. Pure function, no I/O | ~80 |
| `download-pool.ts` | 3-worker FIFO queue. Wraps `runOpencli` (native) or spawns `yt-dlp` (fallback). Tracks per-job log file | ~200 |
| `temp-store.ts` | `register(path) → id`, `get(id) → path`, `sweep() → number`. Background interval | ~80 |
| `semaphore.ts` | Tiny `Semaphore` class (Promise-pool) shared by router and download-pool | ~30 |
| `url-builder.ts` | Builds absolute `download_url` from request headers (extracted to its own module for testability) | ~40 |

### Modified files

- `gateway/src/mcp.ts` — register `video_search` and `video_download` tools.
- `gateway/src/rest.ts` — add `GET /files/:id` route (no auth).
- `Dockerfile` — add `yt-dlp` install in runtime stage.
- `docker-compose.yml` — bind-mount `./data/gateway-tmp:/opt/gateway/tmp`.

### Test files (co-located with code)

- `gateway/src/video/video-router.test.ts`
- `gateway/src/video/video-cookies.test.ts`
- `gateway/src/video/native-dispatcher.test.ts`
- `gateway/src/video/download-pool.test.ts`
- `gateway/src/video/temp-store.test.ts`
- `gateway/src/video/semaphore.test.ts`
- `gateway/src/video/url-builder.test.ts`
- `gateway/src/mcp.video.test.ts` (integration: register tools, call them with a mock `Deps`)

---

### Task 1: Add `video-types.ts` with shared types and platform constants

**Files:**
- Create: `gateway/src/video/video-types.ts`
- Test: `gateway/src/video/video-types.test.ts`

**Interfaces:**
- Consumes: nothing (zero deps)
- Produces: `VIDEO_SITES` (array of 8 site names), `DEFAULT_PLATFORMS` (3 names), `ErrorCode` union, `VideoSearchResult`, `VideoDownloadResult`. Later tasks import from here.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/video-types.test.ts
import { describe, it, expect } from 'vitest';
import { VIDEO_SITES, DEFAULT_PLATFORMS, isVideoSite, ALL_PLATFORMS } from './video-types.js';

describe('video-types', () => {
  it('VIDEO_SITES has exactly 8 entries', () => {
    expect(VIDEO_SITES).toHaveLength(8);
    expect(new Set(VIDEO_SITES).size).toBe(8);
  });

  it('VIDEO_SITES contains the expected sites', () => {
    expect(VIDEO_SITES).toEqual(
      expect.arrayContaining(['bilibili', 'youtube', 'douyin', 'tiktok',
                              'instagram', 'xiaohongshu', 'weibo', 'twitter']),
    );
  });

  it('DEFAULT_PLATFORMS is bilibili, youtube, douyin', () => {
    expect(DEFAULT_PLATFORMS).toEqual(['bilibili', 'youtube', 'douyin']);
  });

  it('isVideoSite returns true for known sites and false for unknown', () => {
    expect(isVideoSite('bilibili')).toBe(true);
    expect(isVideoSite('all')).toBe(false);
    expect(isVideoSite('reddit')).toBe(false);
  });

  it('ALL_PLATFORMS is a sentinel string for video_search platform="all"', () => {
    expect(ALL_PLATFORMS).toBe('all');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/video-types.test.ts`
Expected: FAIL with "Cannot find module './video-types.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/video-types.ts
export const VIDEO_SITES = [
  'bilibili', 'youtube', 'douyin', 'tiktok',
  'instagram', 'xiaohongshu', 'weibo', 'twitter',
] as const;

export type VideoSite = typeof VIDEO_SITES[number];

export const DEFAULT_PLATFORMS: readonly VideoSite[] = ['bilibili', 'youtube', 'douyin'];

export const ALL_PLATFORMS = 'all' as const;

export function isVideoSite(s: string): s is VideoSite {
  return (VIDEO_SITES as readonly string[]).includes(s);
}

export type ErrorCode =
  | 'INVALID_URL'
  | 'URLS_TOO_MANY'
  | 'EMPTY_QUERY'
  | 'INVALID_PLATFORM'
  | 'NATIVE_DOWNLOAD_FAILED'
  | 'YT_DLP_FAILED'
  | 'COOKIE_FETCH_FAILED'
  | 'LOGIN_REQUIRED'
  | 'PAID_CONTENT'
  | 'RATE_LIMITED'
  | 'WORKER_TIMEOUT'
  | 'DISK_FULL';

export interface VideoSearchResult {
  platform: VideoSite;
  id: string;
  title: string;
  url: string;
  author?: string;
  duration?: string;
  views?: number;
  thumbnail?: string;
}

export interface VideoSearchResponse {
  results: VideoSearchResult[];
  stats: {
    requested_platforms: string[];
    succeeded: VideoSite[];
    failed: Array<{ platform: string; error: string }>;
  };
}

export interface VideoDownloadSuccess {
  url: string;
  ok: true;
  method: 'native' | 'ytdlp';
  filename: string;
  size_bytes: number;
  download_url: string;
  expires_at: string;
}

export interface VideoDownloadFailure {
  url: string;
  ok: false;
  error_code: ErrorCode;
  error_message: string;
}

export type VideoDownloadResult = VideoDownloadSuccess | VideoDownloadFailure;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/video-types.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/video-types.ts gateway/src/video/video-types.test.ts
git commit -m "feat(gateway/video): add shared types and platform constants"
```

---

### Task 2: Add `semaphore.ts` for concurrency control

**Files:**
- Create: `gateway/src/video/semaphore.ts`
- Test: `gateway/src/video/semaphore.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class Semaphore` with `acquire(): Promise<void>` and `release(): void`. Used by both `video-router.ts` and `download-pool.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/semaphore.test.ts
import { describe, it, expect } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('permits up to N concurrent acquisitions', async () => {
    const sem = new Semaphore(3);
    const order: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      (async () => {
        await sem.acquire();
        order.push(i);
        // hold briefly
        await new Promise((r) => setTimeout(r, 10));
        sem.release();
      })(),
    );
    await Promise.all(tasks);
    // first 3 should run in parallel (any order), then next 3
    expect(order.slice(0, 3)).toHaveLength(3);
    expect(order).toHaveLength(6);
  });

  it('serialize() runs an async fn under the semaphore', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let maxActive = 0;
    const fn = async (i: number) => {
      await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      sem.release();
      return i;
    };
    await Promise.all([fn(1), fn(2), fn(3)]);
    expect(maxActive).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/semaphore.test.ts`
Expected: FAIL with "Cannot find module './semaphore.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/semaphore.ts
export class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error('Semaphore permits must be >= 1');
    this.available = permits;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }

  async serialize<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/semaphore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/semaphore.ts gateway/src/video/semaphore.test.ts
git commit -m "feat(gateway/video): add Semaphore for concurrency control"
```

---

### Task 3: Add `url-builder.ts` to construct absolute download URLs

**Files:**
- Create: `gateway/src/video/url-builder.ts`
- Test: `gateway/src/video/url-builder.test.ts`

**Interfaces:**
- Consumes: an `IncomingMessage` (or its headers)
- Produces: `buildAbsoluteUrl(req, pathOnHost) → string`. Used by `mcp.ts` when emitting `download_url` and by `rest.ts` for redirects.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/url-builder.test.ts
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { buildAbsoluteUrl } from './url-builder.js';

function mockReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('buildAbsoluteUrl', () => {
  it('uses X-Forwarded-Host when present', () => {
    const url = buildAbsoluteUrl(mockReq({
      'x-forwarded-host': 'textvision.top',
      'x-forwarded-proto': 'https',
      'host': 'localhost:8080',
    }), '/files/abc.mp4');
    expect(url).toBe('https://textvision.top/files/abc.mp4');
  });

  it('uses X-Forwarded-Port when present', () => {
    const url = buildAbsoluteUrl(mockReq({
      'x-forwarded-host': 'textvision.top',
      'x-forwarded-port': '9378',
      'x-forwarded-proto': 'https',
    }), '/files/abc.mp4');
    expect(url).toBe('https://textvision.top:9378/files/abc.mp4');
  });

  it('falls back to Host header', () => {
    const url = buildAbsoluteUrl(mockReq({
      'host': 'localhost:8080',
    }), '/files/abc.mp4');
    expect(url).toBe('http://localhost:8080/files/abc.mp4');
  });

  it('falls back to http when no X-Forwarded-Proto', () => {
    const url = buildAbsoluteUrl(mockReq({ 'host': 'x:8080' }), '/files/y.mp4');
    expect(url).toBe('http://x:8080/files/y.mp4');
  });

  it('handles comma-separated X-Forwarded-Host taking the first', () => {
    const url = buildAbsoluteUrl(mockReq({
      'x-forwarded-host': 'first.example.com, second.example.com',
      'host': 'fallback',
    }), '/p');
    expect(url).toBe('http://first.example.com/p');
  });

  it('returns null when no host info at all', () => {
    const url = buildAbsoluteUrl(mockReq({}), '/files/x.mp4');
    expect(url).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/url-builder.test.ts`
Expected: FAIL with "Cannot find module './url-builder.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/url-builder.ts
import type { IncomingMessage } from 'node:http';

function first(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(',')[0].trim() || undefined;
}

export function buildAbsoluteUrl(
  req: IncomingMessage,
  pathOnHost: string,
): string | null {
  const headers = req.headers;
  const host = first(headers['x-forwarded-host'] as string | undefined) ?? first(headers.host as string | undefined);
  if (!host) return null;
  const proto = first(headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const port = first(headers['x-forwarded-port'] as string | undefined);
  const hasPort = host.includes(':');
  const hostPart = port && !hasPort ? `${host}:${port}` : host;
  const normalizedPath = pathOnHost.startsWith('/') ? pathOnHost : `/${pathOnHost}`;
  return `${proto}://${hostPart}${normalizedPath}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/url-builder.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/url-builder.ts gateway/src/video/url-builder.test.ts
git commit -m "feat(gateway/video): add URL builder for absolute download URLs"
```

---

### Task 4: Add `temp-store.ts` for managing download temp files

**Files:**
- Create: `gateway/src/video/temp-store.ts`
- Test: `gateway/src/video/temp-store.test.ts`

**Interfaces:**
- Consumes: nothing (filesystem access only)
- Produces: `register(absolutePath) → { id, expires_at }`, `get(id) → { path, filename, size_bytes } | undefined`, `sweep() → number` (count deleted). `TempStore` class instance constructed once at gateway boot.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/temp-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TempStore } from './temp-store.js';

describe('TempStore', () => {
  let dir: string;
  let store: TempStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-tempstore-'));
    store = new TempStore({ tmpDir: dir, ttlMs: 60 * 60 * 1000 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('register returns an id and exposes the file', async () => {
    const file = path.join(dir, 'BV1.mp4');
    await fs.writeFile(file, 'hello');
    const { id } = await store.register(file);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const found = store.get(id);
    expect(found?.path).toBe(file);
    expect(found?.filename).toBe('BV1.mp4');
    expect(found?.size_bytes).toBe(5);
  });

  it('get returns undefined for unknown id', () => {
    expect(store.get('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('sweep removes only files older than ttl and only matches video_*', async () => {
    const old = path.join(dir, 'video_old.mp4');
    const fresh = path.join(dir, 'video_fresh.mp4');
    const unrelated = path.join(dir, 'gateway.log');
    await fs.writeFile(old, 'old');
    await fs.writeFile(fresh, 'fresh');
    await fs.writeFile(unrelated, 'log');
    // Backdate old
    const past = Date.now() / 1000 - 7200;
    await fs.utimes(old, past, past);
    const removed = await store.sweep();
    expect(removed).toBe(1);
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/temp-store.test.ts`
Expected: FAIL with "Cannot find module './temp-store.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/temp-store.ts
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TempStoreEntry {
  path: string;
  filename: string;
  size_bytes: number;
  created_at: number;
  expires_at: number;
}

export interface TempStoreOptions {
  tmpDir: string;
  ttlMs: number;
}

export class TempStore {
  private entries = new Map<string, TempStoreEntry>();

  constructor(private opts: TempStoreOptions) {}

  async register(absolutePath: string): Promise<{ id: string; expires_at: string }> {
    const stat = await fs.stat(absolutePath);
    const id = randomUUID();
    const expires_at = Date.now() + this.opts.ttlMs;
    this.entries.set(id, {
      path: absolutePath,
      filename: path.basename(absolutePath),
      size_bytes: stat.size,
      created_at: Date.now(),
      expires_at,
    });
    return { id, expires_at: new Date(expires_at).toISOString() };
  }

  get(id: string): TempStoreEntry | undefined {
    return this.entries.get(id);
  }

  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.opts.ttlMs;
    let removed = 0;
    const entries = [...this.entries.entries()];
    for (const [id, entry] of entries) {
      if (entry.created_at > cutoff) continue;
      try {
        await fs.unlink(entry.path);
      } catch {
        // file already gone, just drop the entry
      }
      this.entries.delete(id);
      removed++;
    }
    return removed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/temp-store.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/temp-store.ts gateway/src/video/temp-store.test.ts
git commit -m "feat(gateway/video): add TempStore with TTL sweep"
```

---

### Task 5: Add `native-dispatcher.ts` for URL → method routing

**Files:**
- Create: `gateway/src/video/native-dispatcher.ts`
- Test: `gateway/src/video/native-dispatcher.test.ts`

**Interfaces:**
- Consumes: a URL string
- Produces: `dispatch(url) → { method: "native" | "ytdlp", site?: string, args: string[], error?: { code, message } }`. Pure function, no I/O. Used by `download-pool.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/native-dispatcher.test.ts
import { describe, it, expect } from 'vitest';
import { dispatch } from './native-dispatcher.js';

describe('native-dispatcher', () => {
  it('routes bilibili BV URLs to native download', () => {
    const r = dispatch('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(r.method).toBe('native');
    expect(r.site).toBe('bilibili');
    expect(r.args).toEqual(expect.arrayContaining(['--bvid', 'BV1xx411c7mD']));
  });

  it('routes bilibili short links (b23.tv) to native download', () => {
    const r = dispatch('https://b23.tv/abc123');
    expect(r.method).toBe('native');
    expect(r.site).toBe('bilibili');
  });

  it('routes instagram /p/ to native download', () => {
    const r = dispatch('https://www.instagram.com/p/ABC123/');
    expect(r.method).toBe('native');
    expect(r.site).toBe('instagram');
    expect(r.args).toEqual(['--url', 'https://www.instagram.com/p/ABC123/']);
  });

  it('routes instagram /reel/ to native download', () => {
    const r = dispatch('https://www.instagram.com/reel/ABC123/?utm_source=ig_web_copy_link');
    expect(r.method).toBe('native');
    expect(r.site).toBe('instagram');
  });

  it('routes youtube URLs to ytdlp', () => {
    const r = dispatch('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.method).toBe('ytdlp');
  });

  it('routes youtu.be short URLs to ytdlp', () => {
    const r = dispatch('https://youtu.be/dQw4w9WgXcQ');
    expect(r.method).toBe('ytdlp');
  });

  it('routes unknown hosts to ytdlp fallback', () => {
    const r = dispatch('https://vimeo.com/12345');
    expect(r.method).toBe('ytdlp');
  });

  it('returns INVALID_URL for non-http schemes', () => {
    const r = dispatch('ftp://example.com/video.mp4');
    expect(r.method).toBe('ytdlp');
    expect(r.error?.code).toBe('INVALID_URL');
  });

  it('returns INVALID_URL for malformed URLs', () => {
    const r = dispatch('not a url');
    expect(r.error?.code).toBe('INVALID_URL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/native-dispatcher.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/native-dispatcher.ts
import type { ErrorCode } from './video-types.js';

export type DispatchMethod = 'native' | 'ytdlp';

export interface DispatchResult {
  method: DispatchMethod;
  site?: string;
  args: string[];
  error?: { code: ErrorCode; message: string };
}

const BV_RE = /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})/i;

function bilibili(url: URL): DispatchResult | null {
  if (url.hostname.endsWith('bilibili.com')) {
    const m = BV_RE.exec(url.pathname);
    if (m) return { method: 'native', site: 'bilibili', args: ['--bvid', m[1]] };
    return null;
  }
  if (url.hostname === 'b23.tv' || url.hostname.endsWith('.b23.tv')) {
    return { method: 'native', site: 'bilibili', args: ['--url', url.toString()] };
  }
  return null;
}

function instagram(url: URL): DispatchResult | null {
  if (!url.hostname.endsWith('instagram.com')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // /p/<shortcode>/ or /reel/<shortcode>/ or /tv/<shortcode>/
  const kind = parts[0];
  if (!['p', 'reel', 'tv'].includes(kind)) return null;
  if (!parts[1]) return null;
  // Normalise to canonical https://www.instagram.com/<kind>/<shortcode>/
  const canonical = `https://www.instagram.com/${kind}/${parts[1]}/`;
  return { method: 'native', site: 'instagram', args: ['--url', canonical] };
}

export function dispatch(rawUrl: string): DispatchResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { method: 'ytdlp', args: [rawUrl], error: { code: 'INVALID_URL', message: `Invalid URL: ${rawUrl}` } };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { method: 'ytdlp', args: [rawUrl], error: { code: 'INVALID_URL', message: `Unsupported protocol: ${url.protocol}` } };
  }
  const bili = bilibili(url);
  if (bili) return bili;
  const ig = instagram(url);
  if (ig) return ig;
  // everything else falls back to yt-dlp
  return { method: 'ytdlp', args: [url.toString()] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/native-dispatcher.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/native-dispatcher.ts gateway/src/video/native-dispatcher.test.ts
git commit -m "feat(gateway/video): add native-dispatcher URL router"
```

---

### Task 6: Add `video-cookies.ts` to export Camofox cookies in Netscape format

**Files:**
- Create: `gateway/src/video/video-cookies.ts`
- Test: `gateway/src/video/video-cookies.test.ts`

**Interfaces:**
- Consumes: a target URL host (e.g. `"www.bilibili.com"`) and the Camofox REST base URL + API key
- Produces: `exportCookiesForHost(host) → { cookieFilePath, cookieCount } | { cookieFilePath, cookieCount: 0, error }`. Writes `/tmp/camofox_cookies_<host>.txt`. Used by `download-pool.ts` before spawning yt-dlp.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/video-cookies.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportCookiesForHost } from './video-cookies.js';

describe('exportCookiesForHost', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cookies-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a Netscape-format cookie file filtered to target host', async () => {
    const fetchCookies = vi.fn().mockResolvedValue([
      { domain: '.bilibili.com', name: 'SESSDATA', value: 'abc', httpOnly: true, secure: false, path: '/', expires: 0 },
      { domain: 'www.bilibili.com', name: 'uid', value: '123', httpOnly: false, secure: false, path: '/', expires: 0 },
      { domain: '.youtube.com', name: 'VISITOR', value: 'x', httpOnly: false, secure: false, path: '/', expires: 0 },
    ]);
    const result = await exportCookiesForHost('www.bilibili.com', {
      tmpDir,
      fetchCookies,
    });
    expect(result.cookieCount).toBe(2);
    expect(result.cookieFilePath).toContain('camofox_cookies_www.bilibili.com.txt');
    const content = await fs.readFile(result.cookieFilePath, 'utf8');
    expect(content).toContain('SESSDATA');
    expect(content).toContain('uid');
    expect(content).not.toContain('VISITOR');
    // Netscape header
    expect(content.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    // httpOnly column is TRUE for SESSDATA
    const sessLine = content.split('\n').find((l) => l.includes('SESSDATA'))!;
    expect(sessLine.split('\t')[1]).toBe('TRUE');
  });

  it('returns empty file and error when fetchCookies throws', async () => {
    const fetchCookies = vi.fn().mockRejectedValue(new Error('network'));
    const result = await exportCookiesForHost('www.bilibili.com', {
      tmpDir,
      fetchCookies,
    });
    expect(result.cookieCount).toBe(0);
    expect(result.error?.code).toBe('COOKIE_FETCH_FAILED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/video-cookies.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/video-cookies.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface CamofoxCookie {
  domain: string;
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  path?: string;
  expires?: number;
}

export interface ExportOptions {
  tmpDir: string;
  fetchCookies: (userId: string) => Promise<CamofoxCookie[]>;
  userId?: string;
}

export interface ExportResult {
  cookieFilePath: string;
  cookieCount: number;
  error?: { code: 'COOKIE_FETCH_FAILED'; message: string };
}

function hostMatches(cookieDomain: string, targetHost: string): boolean {
  const d = cookieDomain.toLowerCase().replace(/^\./, '');
  const h = targetHost.toLowerCase().replace(/^\./, '');
  return d === h || h.endsWith(`.${d}`);
}

function toNetscapeLine(c: CamofoxCookie): string {
  const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
  const httpOnly = c.httpOnly ? 'TRUE' : 'FALSE';
  const secure = c.secure ? 'TRUE' : 'FALSE';
  const cookiePath = c.path ?? '/';
  const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
  return [domain, httpOnly, secure, cookiePath, expires, c.name, c.value].join('\t');
}

export async function exportCookiesForHost(
  targetHost: string,
  opts: ExportOptions,
): Promise<ExportResult> {
  const safeHost = targetHost.replace(/[^a-z0-9.-]/gi, '_');
  const cookieFilePath = path.join(opts.tmpDir, `camofox_cookies_${safeHost}.txt`);
  let cookies: CamofoxCookie[] = [];
  try {
    cookies = await opts.fetchCookies(opts.userId ?? 'default');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fs.writeFile(cookieFilePath, '# Netscape HTTP Cookie File\n', 'utf8');
    return { cookieFilePath, cookieCount: 0, error: { code: 'COOKIE_FETCH_FAILED', message } };
  }
  const filtered = cookies.filter((c) => hostMatches(c.domain, targetHost));
  const header = '# Netscape HTTP Cookie File\n# Generated by camofox-opencli gateway\n\n';
  const body = filtered.map(toNetscapeLine).join('\n') + (filtered.length ? '\n' : '');
  await fs.writeFile(cookieFilePath, header + body, 'utf8');
  return { cookieFilePath, cookieCount: filtered.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/video-cookies.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/video-cookies.ts gateway/src/video/video-cookies.test.ts
git commit -m "feat(gateway/video): add Camofox cookie export to Netscape format"
```

---

### Task 7: Add `download-pool.ts` with 3-worker queue

**Files:**
- Create: `gateway/src/video/download-pool.ts`
- Test: `gateway/src/video/download-pool.test.ts`

**Interfaces:**
- Consumes: a `TempStore`, a `runOpencli` function (existing from `opencli.ts`), a `fetchCamofoxCookies` function, an `exec` function for spawning child processes (dependency-injected for tests)
- Produces: `downloadOne(url, quality) → Promise<VideoDownloadResult>` and `downloadMany(urls, quality) → Promise<VideoDownloadResult[]>`. Used by `mcp.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/download-pool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DownloadPool } from './download-pool.js';
import { TempStore } from './temp-store.js';

describe('DownloadPool', () => {
  let tmpDir: string;
  let store: TempStore;
  let pool: DownloadPool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-dlpool-'));
    store = new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
    pool = new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount: 3,
      runOpencli: vi.fn(),
      fetchCamofoxCookies: async () => [],
      exec: vi.fn(),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns INVALID_URL for non-http URLs without invoking anything', async () => {
    const r = await pool.downloadOne('ftp://x/y', 'best');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe('INVALID_URL');
  });

  it('runs yt-dlp path with cookies file and registers output', async () => {
    const outputFile = path.join(tmpDir, 'out.mp4');
    await fs.writeFile(outputFile, 'fakevideo');
    const exec = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      // expect args contain --cookies and -o
      expect(cmd).toBe('yt-dlp');
      expect(args).toEqual(expect.arrayContaining([expect.stringMatching(/--cookies/), expect.stringMatching(/-o/)]));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    pool.setExec(exec);
    const r = await pool.downloadOne('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe('ytdlp');
      expect(r.filename).toBe('out.mp4');
      expect(r.download_url).toMatch(/\/files\/[0-9a-f-]{36}\.mp4$/);
    }
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('falls back to yt-dlp when native download fails', async () => {
    const outputFile = path.join(tmpDir, 'fallback.mp4');
    await fs.writeFile(outputFile, 'fb');
    const runOpencli = vi.fn().mockResolvedValue({ ok: false, exitCode: 1, stdout: '', stderr: 'paid' });
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    pool = new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount: 3,
      runOpencli,
      fetchCamofoxCookies: async () => [],
      exec,
    });
    const r = await pool.downloadOne('https://www.bilibili.com/video/BV1xx411c7mD', 'best');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('ytdlp');
    expect(runOpencli).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('returns YT_DLP_FAILED when yt-dlp exits non-zero', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '403 forbidden' });
    pool.setExec(exec);
    const r = await pool.downloadOne('https://example.com/video.mp4', 'best');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error_code).toBe('YT_DLP_FAILED');
      expect(r.error_message).toContain('403');
    }
  });

  it('downloadMany caps parallelism at workerCount', async () => {
    let active = 0;
    let maxActive = 0;
    const exec = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    // pre-create output files
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.mp4`), 'x');
    }
    pool.setExec(exec);
    const results = await pool.downloadMany([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://example.com/e',
    ], 'best');
    expect(results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/download-pool.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/download-pool.ts
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { VideoDownloadResult, ErrorCode } from './video-types.js';
import { dispatch } from './native-dispatcher.js';
import { exportCookiesForHost, type CamofoxCookie } from './video-cookies.js';
import { Semaphore } from './semaphore.js';
import type { TempStore } from './temp-store.js';

export interface RunResultLike {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFn {
  (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResultLike>;
}

export interface RunOpencliFn {
  (site: string, command: string, args: string[]): Promise<RunResultLike>;
}

export interface FetchCamofoxCookiesFn {
  (userId: string) => Promise<CamofoxCookie[]>;
}

export interface DownloadPoolOptions {
  tmpDir: string;
  tempStore: TempStore;
  workerCount?: number;
  runOpencli: RunOpencliFn;
  fetchCamofoxCookies: FetchCamofoxCookiesFn;
  exec: ExecFn;
}

export class DownloadPool {
  private sem: Semaphore;
  private tmpDir: string;

  constructor(private opts: DownloadPoolOptions) {
    this.sem = new Semaphore(opts.workerCount ?? 3);
    this.tmpDir = opts.tmpDir;
  }

  /** Test-only setter to swap the exec function between tests. */
  setExec(fn: ExecFn): void { this.opts.exec = fn; }

  async downloadMany(urls: string[], quality: string): Promise<VideoDownloadResult[]> {
    return Promise.all(urls.map((u) => this.downloadOne(u, quality)));
  }

  async downloadOne(rawUrl: string, quality: string): Promise<VideoDownloadResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { url: rawUrl, ok: false, error_code: 'INVALID_URL', error_message: `Invalid URL: ${rawUrl}` };
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { url: rawUrl, ok: false, error_code: 'INVALID_URL', error_message: `Unsupported protocol: ${url.protocol}` };
    }
    return this.sem.serialize(() => this.runJob(rawUrl, url, quality));
  }

  private async runJob(rawUrl: string, url: URL, quality: string): Promise<VideoDownloadResult> {
    const route = dispatch(rawUrl);
    const host = url.hostname;

    // native path
    if (route.method === 'native' && route.site) {
      const nativeResult = await this.runNative(route.site, route.args, quality);
      if (nativeResult.ok) return nativeResult;
      // fall through to ytdlp
    }

    // yt-dlp path (direct, or fallback)
    return this.runYtdlp(rawUrl, host, quality);
  }

  private async runNative(site: string, args: string[], _quality: string): Promise<VideoDownloadResult> {
    const outputTemplate = path.join(this.tmpDir, `video_${randomUUID()}.%(ext)s`);
    const fullArgs = [...args, '--output', outputTemplate];
    const res = await this.opts.runOpencli(site, 'download', fullArgs);
    if (!res.ok) {
      return { url: '', ok: false, error_code: 'NATIVE_DOWNLOAD_FAILED', error_message: res.stderr.slice(0, 500) };
    }
    const file = await this.findOutputFile(outputTemplate);
    if (!file) {
      return { url: '', ok: false, error_code: 'NATIVE_DOWNLOAD_FAILED', error_message: 'output file not found' };
    }
    const { id, expires_at } = await this.opts.tempStore.register(file);
    const entry = this.opts.tempStore.get(id)!;
    return {
      url: '', // caller fills in original URL
      ok: true,
      method: 'native',
      filename: entry.filename,
      size_bytes: entry.size_bytes,
      download_url: `/files/${id}${path.extname(entry.filename)}`,
      expires_at,
    };
  }

  private async runYtdlp(rawUrl: string, host: string, quality: string): Promise<VideoDownloadResult> {
    const cookies = await exportCookiesForHost(host, {
      tmpDir: this.tmpDir,
      fetchCookies: this.opts.fetchCamofoxCookies,
    });
    const outputTemplate = path.join(this.tmpDir, `video_${randomUUID()}.%(ext)s`);
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--cookies', cookies.cookieFilePath,
      '-o', outputTemplate,
      '-f', quality === 'best' ? 'bv*+ba/b' : quality,
      rawUrl,
    ];
    const res = await this.opts.exec('yt-dlp', args, { cwd: this.tmpDir, timeoutMs: 10 * 60 * 1000 });
    if (res.exitCode !== 0) {
      const code: ErrorCode = /Sign in|login|403/.test(res.stderr) ? 'LOGIN_REQUIRED' : 'YT_DLP_FAILED';
      return { url: rawUrl, ok: false, error_code: code, error_message: res.stderr.slice(0, 500) };
    }
    const file = await this.findOutputFile(outputTemplate);
    if (!file) {
      return { url: rawUrl, ok: false, error_code: 'YT_DLP_FAILED', error_message: 'output file not found' };
    }
    const { id, expires_at } = await this.opts.tempStore.register(file);
    const entry = this.opts.tempStore.get(id)!;
    return {
      url: rawUrl,
      ok: true,
      method: 'ytdlp',
      filename: entry.filename,
      size_bytes: entry.size_bytes,
      download_url: `/files/${id}${path.extname(entry.filename)}`,
      expires_at,
    };
  }

  private async findOutputFile(template: string): Promise<string | null> {
    // yt-dlp replaces %(ext)s with the actual extension; look in tmpDir
    const dir = path.dirname(template);
    const prefix = path.basename(template).split('.%(ext)s')[0];
    const files = await fs.readdir(dir);
    const matches = files.filter((f) => f.startsWith(prefix));
    if (matches.length === 0) return null;
    // pick the freshest
    matches.sort();
    return path.join(dir, matches[matches.length - 1]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/download-pool.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/download-pool.ts gateway/src/video/download-pool.test.ts
git commit -m "feat(gateway/video): add DownloadPool with native + yt-dlp paths"
```

---

### Task 8: Add `video-router.ts` for cross-platform search fan-out

**Files:**
- Create: `gateway/src/video/video-router.ts`
- Test: `gateway/src/video/video-router.test.ts`

**Interfaces:**
- Consumes: a `runOpencli` function, the standard `Deps` shape, a per-request `Semaphore` (caller constructs)
- Produces: `search({query, platform?, limit?}, ctx) → Promise<VideoSearchResponse>`. Used by `mcp.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/video/video-router.test.ts
import { describe, it, expect, vi } from 'vitest';
import { searchVideos } from './video-router.js';
import { VIDEO_SITES, DEFAULT_PLATFORMS } from './video-types.js';

describe('searchVideos', () => {
  it('rejects empty query', async () => {
    await expect(searchVideos({ query: '   ' }, { runOpencli: vi.fn() })).rejects.toThrow('EMPTY_QUERY');
  });

  it('rejects unknown platform', async () => {
    await expect(
      searchVideos({ query: 'x', platform: 'reddit' }, { runOpencli: vi.fn() }),
    ).rejects.toThrow('INVALID_PLATFORM');
  });

  it('uses DEFAULT_PLATFORMS when platform is omitted', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0, stdout: JSON.stringify([{ id: 'BV1', title: 't', url: 'u' }]), stderr: '',
    });
    const res = await searchVideos({ query: 'cat' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledTimes(DEFAULT_PLATFORMS.length);
    expect(res.stats.requested_platforms).toEqual([...DEFAULT_PLATFORMS]);
    expect(res.results).toHaveLength(DEFAULT_PLATFORMS.length);
  });

  it('expands platform=all to all VIDEO_SITES', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0, stdout: '[]', stderr: '',
    });
    const res = await searchVideos({ query: 'x', platform: 'all' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledTimes(VIDEO_SITES.length);
    expect(res.stats.requested_platforms).toEqual([...VIDEO_SITES]);
  });

  it('handles single named platform', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0, stdout: '[]', stderr: '',
    });
    const res = await searchVideos({ query: 'x', platform: 'bilibili' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledTimes(1);
    expect(res.stats.requested_platforms).toEqual(['bilibili']);
  });

  it('records per-site failures in stats.failed without aborting', async () => {
    const runOpencli = vi.fn().mockImplementation(async (site: string) => {
      if (site === 'youtube') return { ok: false, exitCode: 1, stdout: '', stderr: 'AUTH_REQUIRED' };
      return { ok: true, exitCode: 0, stdout: '[]', stderr: '' };
    });
    const res = await searchVideos({ query: 'x' }, { runOpencli });
    expect(res.results).toHaveLength(2); // bilibili + douyin
    expect(res.stats.failed).toEqual([{ platform: 'youtube', error: 'AUTH_REQUIRED' }]);
    expect(res.stats.succeeded).toEqual(['bilibili', 'douyin']);
  });

  it('clamps limit to [1, 30] with default 10', async () => {
    const runOpencli = vi.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: '[]', stderr: '' });
    await searchVideos({ query: 'x', limit: 999 }, { runOpencli });
    expect(runOpencli.mock.calls[0][2]).toEqual(expect.arrayContaining(['--limit', '30']));
    await searchVideos({ query: 'x' }, { runOpencli });
    expect(runOpencli.mock.calls[1][2]).toEqual(expect.arrayContaining(['--limit', '10']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/video/video-router.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
// gateway/src/video/video-router.ts
import { VIDEO_SITES, DEFAULT_PLATFORMS, ALL_PLATFORMS, isVideoSite, type VideoSite, type VideoSearchResponse, type VideoSearchResult } from './video-types.js';
import { Semaphore } from './semaphore.js';
import type { RunResultLike, RunOpencliFn } from './download-pool.js';

export interface SearchInput {
  query: string;
  platform?: string;
  limit?: number;
}

export interface RouterDeps {
  runOpencli: RunOpencliFn;
  concurrency?: number;
}

const SEARCH_SEMAPHORE = new Semaphore(3);

function resolvePlatforms(input: SearchInput): VideoSite[] {
  if (!input.platform) return [...DEFAULT_PLATFORMS];
  if (input.platform === ALL_PLATFORMS) return [...VIDEO_SITES];
  if (!isVideoSite(input.platform)) {
    throw Object.assign(new Error(`INVALID_PLATFORM: ${input.platform}`), { code: 'INVALID_PLATFORM' });
  }
  return [input.platform];
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return 10;
  if (limit > 30) return 30;
  return limit;
}

async function searchOneSite(
  site: VideoSite,
  query: string,
  limit: number,
  runOpencli: RunOpencliFn,
): Promise<VideoSearchResult[]> {
  const args = [query, '--format', 'json', '--limit', String(limit)];
  const res = await runOpencli(site, 'search', args);
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    const rows: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
    return rows.map((row) => mapRow(site, row)).filter((r): r is VideoSearchResult => r !== null);
  } catch {
    return [];
  }
}

function mapRow(site: VideoSite, row: any): VideoSearchResult | null {
  const id = String(row.id ?? row.bvid ?? row.video_id ?? row.aweme_id ?? row.shortcode ?? '');
  const title = String(row.title ?? row.desc ?? row.name ?? '');
  const url = String(row.url ?? row.video_url ?? canonicalUrl(site, id));
  if (!id || !title || !url) return null;
  return {
    platform: site,
    id,
    title,
    url,
    author: row.author ?? row.user ?? row.nickname,
    duration: row.duration,
    views: typeof row.views === 'number' ? row.views : row.view_count ?? row.play_count,
    thumbnail: row.thumbnail ?? row.cover ?? row.pic,
  };
}

function canonicalUrl(site: VideoSite, id: string): string {
  switch (site) {
    case 'bilibili': return `https://www.bilibili.com/video/${id}`;
    case 'youtube': return `https://www.youtube.com/watch?v=${id}`;
    case 'douyin': return `https://www.douyin.com/video/${id}`;
    case 'tiktok': return `https://www.tiktok.com/@_/video/${id}`;
    case 'instagram': return `https://www.instagram.com/p/${id}/`;
    case 'xiaohongshu': return `https://www.xiaohongshu.com/explore/${id}`;
    case 'weibo': return `https://weibo.com/${id}`;
    case 'twitter': return `https://x.com/i/status/${id}`;
  }
}

export async function searchVideos(input: SearchInput, deps: RouterDeps): Promise<VideoSearchResponse> {
  const query = (input.query ?? '').trim();
  if (!query) throw Object.assign(new Error('EMPTY_QUERY'), { code: 'EMPTY_QUERY' });
  const sites = resolvePlatforms(input);
  const limit = clampLimit(input.limit);
  const sem = new Semaphore(deps.concurrency ?? 3);
  const settled = await Promise.allSettled(
    sites.map((site) => sem.serialize(async () => {
      try {
        const results = await searchOneSite(site, query, limit, deps.runOpencli);
        return { site, ok: true as const, results, error: null as string | null };
      } catch (err) {
        return { site, ok: false as const, results: [], error: (err as Error).message };
      }
    })),
  );
  const allResults: VideoSearchResult[] = [];
  const succeeded: VideoSite[] = [];
  const failed: Array<{ platform: string; error: string }> = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const v = s.value;
      if (v.ok) {
        allResults.push(...v.results);
        succeeded.push(v.site);
      } else {
        failed.push({ platform: v.site, error: v.error ?? 'unknown' });
      }
    } else {
      failed.push({ platform: 'unknown', error: String(s.reason) });
    }
  }
  return {
    results: allResults,
    stats: {
      requested_platforms: sites as string[],
      succeeded,
      failed,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/video/video-router.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/video/video-router.ts gateway/src/video/video-router.test.ts
git commit -m "feat(gateway/video): add cross-platform video_search router"
```

---

### Task 9: Wire `mcp.ts` to register `video_search` and `video_download`

**Files:**
- Modify: `gateway/src/mcp.ts:1-30` (imports) and add new tool registrations before `export { ... }`
- Test: `gateway/src/mcp.video.test.ts` (new integration test)

**Interfaces:**
- Consumes: existing `Deps` (provides `cfg`, `manifest`, `run`, `vnc`); `buildAbsoluteUrl(req, path)` from `video/url-builder.ts`; `searchVideos` from `video/video-router.ts`; `DownloadPool` from `video/download-pool.ts`
- Produces: Two new MCP tool registrations, callable via `/mcp`

- [ ] **Step 1: Write the failing integration test**

```ts
// gateway/src/mcp.video.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMcpServer } from './mcp.js';
import type { Manifest } from './manifest.js';
import type { Config } from './config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function makeDeps() {
  const manifest: Manifest = {
    getSiteHelp: vi.fn().mockReturnValue([]),
    listSites: vi.fn().mockReturnValue([]),
    searchSites: vi.fn().mockReturnValue([]),
  } as unknown as Manifest;
  const cfg: Config = {
    apiKey: '',
    manifestPath: '/tmp/m.json',
    tmpDir: '/tmp',
    logDir: '/tmp',
    logLevel: 'info',
  };
  return {
    cfg,
    manifest,
    run: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: '[]', stderr: '' }),
    vnc: vi.fn(),
  };
}

describe('MCP video tools', () => {
  let server: ReturnType<typeof buildMcpServer>;
  let client: Client;

  beforeEach(async () => {
    const deps = makeDeps();
    server = buildMcpServer(deps);
    client = new Client({ name: 'test', version: '0' });
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(t1), client.connect(t2)]);
  });

  it('registers video_search', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('video_search');
  });

  it('registers video_download', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('video_download');
  });

  it('video_search rejects empty query', async () => {
    const result = await client.callTool({ name: 'video_search', arguments: { query: '' } });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/mcp.video.test.ts`
Expected: FAIL with "buildMcpServer is not a function" or similar (current `mcp.ts` does not export `buildMcpServer`).

- [ ] **Step 3: Refactor `mcp.ts` to export `buildMcpServer(deps)`**

Open `gateway/src/mcp.ts`. Find the existing function that builds the `McpServer` (it currently lives inside the per-request handler — search for `new McpServer`). Refactor as follows:

a. At the top of the file, add these imports:

```ts
import { searchVideos } from './video/video-router.js';
import { DownloadPool } from './video/download-pool.js';
import { TempStore } from './video/temp-store.js';
import { buildAbsoluteUrl } from './video/url-builder.js';
import * as fs from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
```

b. Promote the existing `McpServer` construction into an exported function:

```ts
const execAsync = promisify(execCb);

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'camofox-opencli', version: '0.1.0' });

  // existing tools (list_sites, site_help, run_command, search, login, doctor)
  // ... preserve all existing registrations ...

  // Lazy-init video subsystem (per-server, not per-request)
  const tmpDir = process.env.GATEWAY_TMP_DIR ?? './tmp';
  const tempStore = new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
  const camofoxBase = process.env.CAMOFOX_BASE_URL ?? `http://127.0.0.1:${deps.cfg.camofoxPort ?? 9377}`;
  const camofoxKey = process.env.CAMOFOX_API_KEY ?? '';
  const userId = process.env.CAMOFOX_USER_ID ?? 'default';

  const downloadPool = new DownloadPool({
    tmpDir,
    tempStore,
    workerCount: 3,
    runOpencli: async (site, command, args) => {
      const r = await deps.run(site, command, args);
      return { ok: r.ok, exitCode: r.ok ? 0 : 1, stdout: r.ok ? JSON.stringify(r.data) : '', stderr: r.ok ? '' : JSON.stringify(r.data) };
    },
    fetchCamofoxCookies: async (uid) => {
      const url = `${camofoxBase}/sessions/${encodeURIComponent(uid)}/cookies`;
      const headers: Record<string, string> = {};
      if (camofoxKey) headers['Authorization'] = `Bearer ${camofoxKey}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Camofox cookies HTTP ${res.status}`);
      return (await res.json()) as Array<{ domain: string; name: string; value: string; httpOnly?: boolean; secure?: boolean; path?: string; expires?: number }>;
    },
    exec: execAsync,
  });

  // sweep on boot
  void tempStore.sweep();
  setInterval(() => { void tempStore.sweep(); }, 10 * 60 * 1000).unref();

  server.registerTool(
    'video_search',
    {
      description: `Search videos across supported platforms. Default platforms (when 'platform' is omitted): bilibili, youtube, douyin. Use platform="all" to search all 8 supported sites (bilibili, youtube, douyin, tiktok, instagram, xiaohongshu, weibo, twitter). Up to 3 sites searched in parallel.`,
      inputSchema: {
        query: z.string().min(1).describe('Search keywords'),
        platform: z.string().optional().describe('Site name, "all", or omit for default 3'),
        limit: z.number().int().min(1).max(30).optional().describe('Results per site (default 10)'),
      },
    },
    async (args, extra) => {
      try {
        const res = await searchVideos(
          { query: args.query, platform: args.platform, limit: args.limit },
          { runOpencli: async (site, command, argv) => {
              const r = await deps.run(site, command, argv);
              return { ok: r.ok, exitCode: r.ok ? 0 : 1, stdout: r.ok ? JSON.stringify(r.data) : '', stderr: r.ok ? '' : JSON.stringify(r.data) };
            } },
        );
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      } catch (err) {
        const code = (err as any)?.code ?? 'INVALID_PLATFORM';
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: (err as Error).message } }) }] };
      }
    },
  );

  server.registerTool(
    'video_download',
    {
      description: 'Download 1-3 video URLs to a temp file inside the container and return a temporary HTTPS URL the client can GET to fetch the bytes. Files are deleted after 1 hour. Supports bilibili, instagram natively; all other platforms via yt-dlp.',
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(3),
        quality: z.enum(['best', '1080p', '720p', '480p', 'worst']).optional(),
      },
    },
    async (args, extra) => {
      const quality = args.quality ?? 'best';
      const results = await downloadPool.downloadMany(args.urls, quality);
      // Patch original URL + absolute download_url
      const patched = results.map((r, i) => {
        if (!r.ok) return r;
        const abs = buildAbsoluteUrl(extra?.request ?? {} as any, r.download_url);
        return { ...r, url: args.urls[i], download_url: abs ?? r.download_url };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ results: patched }) }] };
    },
  );

  return server;
}
```

c. Update the existing per-request handler in `gateway/src/mcp.ts` (search for `createMcpHandler` or wherever the existing code creates the per-request server) to use `buildMcpServer(deps)` instead of inline construction. Preserve the per-request `StreamableHTTPServerTransport` instantiation.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/mcp.video.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/mcp.ts gateway/src/mcp.video.test.ts
git commit -m "feat(gateway/mcp): register video_search and video_download tools"
```

---

### Task 10: Add `GET /files/:id` route to `rest.ts`

**Files:**
- Modify: `gateway/src/rest.ts` (add route inside `createRestHandler`)
- Test: `gateway/src/rest.files.test.ts` (new)

**Interfaces:**
- Consumes: `TempStore` (must be wired in via `Deps`); an `IncomingMessage`, `ServerResponse`
- Produces: a public HTTP route that streams the temp file. No auth.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/rest.files.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRestHandler } from './rest.js';
import { TempStore } from './video/temp-store.js';
import type { Config } from './config.js';
import type { Manifest } from './manifest.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('GET /files/:id', () => {
  let tmpDir: string;
  let tempStore: TempStore;
  let handler: ReturnType<typeof createRestHandler>;
  let res: any;
  let writeHead: ReturnType<typeof vi.fn>;
  let end: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-files-'));
    tempStore = new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
    const cfg: Config = { apiKey: '', manifestPath: '', tmpDir, logDir: '/tmp', logLevel: 'info' };
    const manifest: Manifest = { getSiteHelp: vi.fn(), listSites: vi.fn(), searchSites: vi.fn() } as unknown as Manifest;
    handler = createRestHandler({ cfg, manifest, tempStore, run: vi.fn(), vnc: vi.fn() });
    writeHead = vi.fn();
    end = vi.fn();
    res = { setHeader: vi.fn(), writeHead, end };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockReq(method: string, url: string): IncomingMessage {
    return { method, url, headers: { host: 'localhost:8080' } } as unknown as IncomingMessage;
  }

  it('streams the registered file with attachment header', async () => {
    const file = path.join(tmpDir, 'BV1.mp4');
    await fs.writeFile(file, 'video-bytes');
    const { id } = await tempStore.register(file);
    await handler(mockReq('GET', `/files/${id}.mp4`), res);
    expect(writeHead).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('attachment'));
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', expect.stringMatching(/video|octet-stream/));
    expect(end).toHaveBeenCalled();
  });

  it('returns 404 for unknown id', async () => {
    await handler(mockReq('GET', '/files/00000000-0000-0000-0000-000000000000.mp4'), res);
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(JSON.parse(end.mock.calls[0][0]).ok).toBe(false);
  });

  it('requires GET method (405 for POST)', async () => {
    const file = path.join(tmpDir, 'a.mp4');
    await fs.writeFile(file, 'x');
    const { id } = await tempStore.register(file);
    await handler(mockReq('POST', `/files/${id}.mp4`), res);
    expect(writeHead).toHaveBeenCalledWith(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/rest.files.test.ts`
Expected: FAIL with "tempStore is required" or similar.

- [ ] **Step 3: Modify `rest.ts`**

Open `gateway/src/rest.ts`.

a. Extend `Deps` interface (top of file) to add an optional `tempStore`:

```ts
import type { TempStore } from './video/temp-store.js';

export interface Deps {
  cfg: Config;
  manifest: Manifest;
  run: (site: string, command: string, argv: string[], opts?: { passthrough?: boolean }) => Promise<RunResult>;
  vnc: (opts: { url?: string; clientHost?: string }) => Promise<string>;
  tempStore?: TempStore;
}
```

b. Add a helper `mimeFor(filename)` near the top of the file:

```ts
function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'application/octet-stream';
}
```

c. Add the import for `path`:

```ts
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
```

d. Inside `createRestHandler`, just before the existing auth check, add the route handler (it must run BEFORE auth so it's public):

```ts
    if (method === 'GET' && path.startsWith('/files/')) {
      if (!deps.tempStore) return err(res, 503, 'unavailable', 'temp store not configured');
      const idWithExt = path.slice('/files/'.length);
      const id = idWithExt.split('.')[0];
      const entry = deps.tempStore.get(id);
      if (!entry) return err(res, 404, 'not_found', 'file missing or expired');
      res.setHeader('Content-Type', mimeFor(entry.filename));
      res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
      res.setHeader('Content-Length', String(entry.size_bytes));
      res.writeHead(200);
      createReadStream(entry.path).pipe(res);
      return;
    }
```

e. Add a 405 fallback for any other method on `/files/*`:

```ts
    if (path.startsWith('/files/') && method !== 'GET') {
      return err(res, 405, 'method_not_allowed', 'only GET is supported on /files');
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/rest.files.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full gateway test suite**

Run: `cd gateway && npx vitest run`
Expected: PASS (all previous + new tests, zero failures)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/rest.ts gateway/src/rest.files.test.ts
git commit -m "feat(gateway/rest): add public GET /files/:id route for temp downloads"
```

---

### Task 11: Wire `TempStore` into `gateway/src/index.ts`

**Files:**
- Modify: `gateway/src/index.ts` (where `createRestHandler` is called)
- No new test (covered by integration test in Task 12)

**Interfaces:**
- Consumes: `cfg.tmpDir`, the new `video/` modules
- Produces: a singleton `TempStore` passed to `createRestHandler` and `buildMcpServer`

- [ ] **Step 1: Read `gateway/src/index.ts` to find the call site**

Run: `grep -n "createRestHandler\|buildMcpServer" gateway/src/index.ts`

- [ ] **Step 2: Add TempStore instantiation**

Edit `gateway/src/index.ts` near the top of the bootstrap function. Add:

```ts
import { TempStore } from './video/temp-store.js';

// inside bootstrap():
const tmpDir = process.env.GATEWAY_TMP_DIR ?? './tmp';
const tempStore = new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
void tempStore.sweep();
setInterval(() => { void tempStore.sweep(); }, 10 * 60 * 1000).unref();
```

Pass `tempStore` into both `createRestHandler` and `buildMcpServer` (whichever the file constructs).

- [ ] **Step 3: Verify gateway still compiles**

Run: `cd gateway && npm run build`
Expected: zero TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/index.ts
git commit -m "feat(gateway): wire TempStore singleton with sweep interval"
```

---

### Task 12: Add `yt-dlp` to Dockerfile and bind-mount `./tmp`

**Files:**
- Modify: `Dockerfile` (runtime stage)
- Modify: `docker-compose.yml` (gateway service volumes)

- [ ] **Step 1: Add `yt-dlp` install to the Dockerfile runtime stage**

Open `Dockerfile`. Find the final `FROM ... AS runtime` stage. Add a `RUN` line (after any existing `apt-get install` line, or create one) that installs yt-dlp:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends yt-dlp ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

If the image already has Python and you prefer pip:

```dockerfile
RUN pip install --no-cache-dir --break-system-packages yt-dlp
```

(Choose the variant that matches the existing Dockerfile's package manager style. If neither apt-get nor pip is used, add the smallest one.)

- [ ] **Step 2: Add `./tmp` directory creation**

In the same runtime stage, ensure the gateway's working dir has a `./tmp` directory:

```dockerfile
RUN mkdir -p /opt/gateway/tmp && chown -R node:node /opt/gateway
```

(Use the actual path the gateway process runs from, e.g. `/opt/gateway` if that's where `dist/` lives — verify by checking existing `WORKDIR` and `COPY` instructions.)

- [ ] **Step 3: Add bind-mount to `docker-compose.yml`**

Open `docker-compose.yml`. Find the `gateway` (or equivalent) service. Add a new volume entry:

```yaml
    volumes:
      - ./data/cookies:/opt/camofox/cookies  # if this exists
      - ./data/gateway-tmp:/opt/gateway/tmp   # new
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "build: install yt-dlp and mount gateway tmp directory"
```

---

### Task 13: Build, smoke-test, and deploy

**Files:** None modified. This task is a runtime verification.

- [ ] **Step 1: Type-check the gateway**

Run: `cd gateway && npm run build`
Expected: zero TypeScript errors.

- [ ] **Step 2: Run all gateway tests**

Run: `cd gateway && npx vitest run`
Expected: PASS (all video tests + existing 52 tests = ~70+ tests, zero failures).

- [ ] **Step 3: Run the dev mock locally**

Run: `cd gateway && npm run dev:mock`
Then in another shell:

```bash
curl -s http://localhost:8080/health
# expect: {"ok":true,"data":{"status":"up"}}
```

- [ ] **Step 4: Smoke-test `video_search` via the live `/mcp` endpoint**

Use any MCP client (Claude Code, mcp-cli, or a curl-based JSON-RPC client). Call `video_search` with `query="lofi"` and `platform="bilibili"`. Assert the response is JSON with `results: [...]` non-empty within 10s.

- [ ] **Step 5: Smoke-test `video_download` via `/mcp`**

Call `video_download` with `urls: ["https://www.youtube.com/watch?v=jNQXAC9IVRw"]` (the first YouTube video ever, short). Assert:
- Response is JSON with one `results` entry.
- `download_url` matches `https://<host>:8080/files/<uuid>.mp4`.
- `curl <download_url>` returns HTTP 200 with a non-empty body.

- [ ] **Step 6: Deploy to production**

Run from the server:

```bash
cd /www/dk_project/dk_app/camofox-opencli
git pull && ./deploy.sh
```

Expected: image rebuilds, container restarts, `/health` returns OK, `/mcp` accepts `video_search` calls.

- [ ] **Step 7: Add the nginx `location /files/` proxy on the server**

Manual one-time edit on `textvision.top` in the Baota nginx config (or whatever fronts the gateway):

```nginx
location /files/ {
    proxy_pass http://127.0.0.1:9378;  # gateway port
}
```

Reload nginx. Verify with `curl https://textvision.top:8080/files/<id>.mp4` returns 200.

- [ ] **Step 8: Commit any deployment config tweaks**

```bash
git add .
git commit -m "chore: post-deploy tweaks"
```

(Empty commit allowed if no changes.)

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `video_search` schema, 8 platforms, default 3, "all" | T1 (constants), T8 (router), T9 (registration) |
| 3-site semaphore | T2, T8 |
| `video_download` schema, 1-3 URLs, quality | T1, T7, T9 |
| Native vs yt-dlp routing | T5 (dispatcher), T7 (pool) |
| Camofox cookie injection | T6 |
| Absolute download_url from headers | T3 |
| TempStore + 1h TTL + sweep | T4, T11 |
| `GET /files/:id` no auth | T10 |
| 9 supported sites constant | T1 |
| yt-dlp dependency | T12 |
| Error codes (12) | T1 (union), T7 (mapping), T9 (surfacing) |
| docker-compose bind-mount | T12 |
| nginx /files/ proxy | T13 |

No gaps.

**Placeholder scan:** searched the plan for "TBD", "TODO", "implement later", "add validation", "similar to task", "fill in details". None found. ✅

**Type consistency:**
- `VideoSite` defined in T1, used in T5 (dispatch doesn't actually use it), T8 (`VideoSite[]`, `isVideoSite`).
- `VideoDownloadResult` defined in T1, returned by T7 `downloadOne` / `downloadMany`, consumed by T9.
- `ErrorCode` defined in T1, mapped by T7, surfaced by T9.
- `TempStore` class shape: `register/get/sweep` defined in T4, consumed by T7 (`register`, `get`) and T10 (`get`).
- `Semaphore`: `acquire/release/serialize` defined in T2, used by T7 (`sem.serialize`) and T8 (constructed fresh per call). ✅

Plan complete and saved to `docs/superpowers/plans/2026-07-21-video-tools.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?