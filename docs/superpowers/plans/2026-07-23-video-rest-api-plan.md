# Video Search / Download REST API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 camofox-opencli 网关上把现有 MCP 工具 `video_search` / `video_download` 暴露为 REST 端点 `POST /video/search` 与 `POST /video/download`，与 MCP 共享同一份业务代码。

**Architecture:** 新增 `src/gateway/video/video-handlers.ts`，把 mcp.ts 中 video handler 的逻辑抽成两个 pure 函数 `runVideoSearch` / `runVideoDownload`。MCP handler 与新 REST 路由都调用这两个函数。MCP 路径行为字节级保持不变（envelope、日志、错误码完全不动）。

**Tech Stack:** Node.js / TypeScript / Vitest / `@modelcontextprotocol/sdk`（已存在）。

## Global Constraints

- 现有 114 个测试**全部不动**、必须全绿。
- `src/gateway/video/` 下业务模块（`video-router.ts`、`video-cookies.ts`、`download-pool.ts`、`temp-store.ts`、`url-builder.ts`、`video-types.ts`）**逻辑零改动**——只允许新增文件 `video-handlers.ts`。
- `src/gateway/core/*`、`src/gateway/api/rest.ts` 中除新增可选第二形参外的所有路径（`/health`、`/sites`、`/sites/:site/help`、`/run`、`/login`、`/files/:id`）**不动**。
- MCP handler 的字节序列（`server.registerTool('video_search', ...)` 与 `server.registerTool('video_download', ...)` 内部 handler 现有实现）**逐字**搬移到 `video-handlers.ts`；MCP handler 仅剩 envelope 包装。
- 所有错误码字符串（`EMPTY_QUERY` / `INVALID_PLATFORM` / `INVALID_URL` / `LOGIN_REQUIRED` / `YT_DLP_FAILED` 等）保持现状。
- REST 鉴权复用 `GATEWAY_API_KEY` Bearer header；`/files/:id` 仍免鉴权。
- 测试 `Config` mock 字段：`apiKey`、`manifestPath`、`tmpDir`、`logDir`、`logLevel`、`cookieDir`、`outputDir`、`proxyUrl`（与 `mcp.video.test.ts` 一致）。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/gateway/video/video-handlers.ts` | **新建** | 导出 `runVideoSearch` / `runVideoDownload` / `VideoHandlerCtx`。MCP 与 REST 共用的业务函数。 |
| `src/gateway/mcp/mcp.ts` | **修改** | `video_search` / `video_download` MCP handler 改为调用 `runVideoSearch` / `runVideoDownload`；其它字节序列（含 `VideoSubsystem`、`getVideoSubsystem`、所有 `server.registerTool` 行）保持不变。 |
| `src/gateway/api/rest.ts` | **修改** | `createRestHandler` 新增可选第二形参 `video?: { search, download, subsystem }`；在 try 块内新增 `POST /video/search` 与 `POST /video/download` 两条路由；现有路径全部不动。 |
| `src/gateway/mcp/index.ts` | **修改** | 导入两个 handler 与 `videoSubsystem`，把它们注入 `createRestHandler(deps, { video: { search, download, subsystem } })`；现有 HTTP server、`/mcp` 路由、`/health`、`/files/:id` 不动。 |
| `tests/gateway/rest.video.test.ts` | **新建** | vitest 单测覆盖 §6 测试矩阵。 |

## Task Dependencies

```
Task 1 (新建 video-handlers.ts + 单测)
   ↓
Task 2 (改 mcp.ts 调 video-handlers)
   ↓
Task 3 (改 rest.ts 加 /video/* 路由)
   ↓
Task 4 (改 index.ts 装配)
   ↓
Task 5 (rest.video.test.ts 端到端 + 部署)
```

每个任务末尾都有独立可验证的 deliverable。

### Task 1: 新建 `src/gateway/video/video-handlers.ts` + 单测

**Files:**
- Create: `src/gateway/video/video-handlers.ts`
- Create: `tests/gateway/video-handlers.test.ts`

**Interfaces:**
- Consumes:
  - `Deps`（来自 `../api/rest.js`）
  - `VideoSubsystem`（来自 `../mcp/mcp.js`）
  - `IncomingMessage`（来自 `node:http`）
  - `searchVideos` 与 `RouterDeps`（来自 `./video-router.js`）
  - `buildAbsoluteUrl`（来自 `./url-builder.js`）
  - `log`（来自 `../core/logger.js`）
- Produces:
  - `interface VideoHandlerCtx { deps: Deps; video: VideoSubsystem; req: IncomingMessage; clientHost: string | null; }`
  - `function runVideoSearch(input: { query: string; platform?: string; limit?: number }, ctx: VideoHandlerCtx): Promise<VideoSearchResponse>`
  - `function runVideoDownload(input: { urls: string[]; quality?: string }, ctx: VideoHandlerCtx): Promise<{ results: VideoDownloadResult[] }>`

- [ ] **Step 1: 写失败测试 `tests/gateway/video-handlers.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runVideoSearch, runVideoDownload, type VideoHandlerCtx } from '../../src/gateway/video/video-handlers.js';
import type { Deps } from '../../src/gateway/api/rest.js';
import type { Manifest } from '../../src/gateway/core/manifest.js';
import type { Config } from '../../src/gateway/core/config.js';
import type { VideoSubsystem } from '../../src/gateway/mcp/mcp.js';
import { TempStore } from '../../src/gateway/video/temp-store.js';

function makeDeps(tmpDir: string): Deps {
  const manifest: Manifest = {
    getSiteHelp: vi.fn().mockReturnValue([]),
    listSites: vi.fn().mockReturnValue([]),
    searchSites: vi.fn().mockReturnValue([]),
  } as unknown as Manifest;
  const cfg: Config = {
    apiKey: '',
    manifestPath: '/tmp/m.json',
    tmpDir,
    logDir: '/tmp',
    logLevel: 'info',
    cookieDir: '/tmp',
    outputDir: '/tmp',
    proxyUrl: null,
  };
  return {
    cfg,
    manifest,
    run: vi.fn(),
    vnc: vi.fn(),
    tempStore: new TempStore({ tmpDir, ttlMs: 60_000 }),
  };
}

function makeCtx(deps: Deps): VideoHandlerCtx {
  const video: VideoSubsystem = {
    pool: { downloadMany: vi.fn() } as unknown as VideoSubsystem['pool'],
    fetchCookies: vi.fn(),
  };
  return {
    deps,
    video,
    req: { headers: {} } as unknown as import('node:http').IncomingMessage,
    clientHost: 'testhost',
  };
}

describe('runVideoSearch', () => {
  it('propagates EMPTY_QUERY when query is empty', async () => {
    const deps = makeDeps('/tmp');
    const ctx = makeCtx(deps);
    await expect(runVideoSearch({ query: '' }, ctx))
      .rejects.toMatchObject({ code: 'EMPTY_QUERY' });
  });

  it('returns VideoSearchResponse when all sites ok', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vh-'));
    try {
      const deps = makeDeps(tmpDir);
      deps.run = vi.fn().mockResolvedValue({
        ok: true,
        data: [{ id: 'BV1', title: 't1', url: 'https://www.bilibili.com/video/BV1' }],
      });
      const ctx = makeCtx(deps);
      const res = await runVideoSearch({ query: 'x' }, ctx);
      expect(res.results.length).toBeGreaterThan(0);
      expect(res.stats.succeeded.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runVideoDownload', () => {
  it('returns results array from pool.downloadMany', async () => {
    const deps = makeDeps('/tmp');
    const ctx = makeCtx(deps);
    (ctx.video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        url: 'https://x/y',
        ok: true,
        method: 'ytdlp',
        filename: 'video_abc.mp4',
        size_bytes: 1024,
        download_url: '/files/abc.mp4',
        expires_at: '2099-01-01T00:00:00Z',
      },
    ]);
    const out = await runVideoDownload({ urls: ['https://x/y'] }, ctx);
    expect(out.results[0].ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run tests/gateway/video-handlers.test.ts`
Expected: FAIL —— `Cannot find module '../../src/gateway/video/video-handlers.js'`

- [ ] **Step 3: 在 mcp.ts 顶部把 `VideoSubsystem` 改为 `export`**

修改文件：`src/gateway/mcp/mcp.ts:189-192`

找到：
```ts
/** Lazy video subsystem built once per server (deps.tempStore is shared). */
interface VideoSubsystem {
  pool: DownloadPool;
  fetchCookies: (userId: string) => Promise<CamofoxCookie[]>;
}
```

改为：
```ts
/** Lazy video subsystem built once per server (deps.tempStore is shared). */
export interface VideoSubsystem {
  pool: DownloadPool;
  fetchCookies: (userId: string) => Promise<CamofoxCookie[]>;
}
```

不改其它任何东西——`_video` 单例、`getVideoSubsystem` 函数体完全不动。

- [ ] **Step 4: 新建 `src/gateway/video/video-handlers.ts`**

```ts
import type { IncomingMessage } from 'node:http';
import type { Deps } from '../api/rest.js';
import { log } from '../core/logger.js';
import { searchVideos, type RouterDeps } from './video-router.js';
import { buildAbsoluteUrl } from './url-builder.js';
import type { VideoSearchResponse, VideoDownloadResult } from './video-types.js';
import type { VideoSubsystem } from '../mcp/mcp.js';

export interface VideoHandlerCtx {
  deps: Deps;
  video: VideoSubsystem;
  req: IncomingMessage;
  clientHost: string | null;
}

export async function runVideoSearch(
  input: { query: string; platform?: string; limit?: number },
  ctx: VideoHandlerCtx,
): Promise<VideoSearchResponse> {
  log.info('video.search.start', { query: input.query, platform: input.platform ?? null, limit: input.limit ?? null });
  try {
    const routerDeps: RouterDeps = {
      runOpencli: async (site, command, argv) => {
        const r = await ctx.deps.run(site, command, argv);
        const ok = !!r.ok;
        return {
          ok,
          exitCode: ok ? 0 : 1,
          stdout: ok ? JSON.stringify(r.data ?? {}) : '',
          stderr: ok ? '' : (r.stderr ?? JSON.stringify(r.data ?? {})),
        };
      },
    };
    const res = await searchVideos(
      { query: input.query, platform: input.platform, limit: input.limit },
      routerDeps,
    );
    log.info('video.search.done', {
      query: input.query,
      platform: input.platform ?? null,
      results: res.results.length,
      ok: res.stats.succeeded.length,
      failed: res.stats.failed.length,
    });
    return res;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'EMPTY_QUERY';
    log.warn('video.search.error', { query: input.query, platform: input.platform ?? null, code, message: (err as Error).message });
    throw err;
  }
}

export async function runVideoDownload(
  input: { urls: string[]; quality?: string },
  ctx: VideoHandlerCtx,
): Promise<{ results: VideoDownloadResult[] }> {
  const q = input.quality ?? 'best';
  log.info('video.download.start', { urls: input.urls.map((u) => new URL(u).hostname), quality: q });
  const t0 = Date.now();
  const results = await ctx.video.pool.downloadMany(input.urls, q);
  const patched = results.map((r, i) => {
    if (!r.ok) return r;
    const abs = buildAbsoluteUrl(ctx.req, r.download_url);
    return { ...r, url: input.urls[i], download_url: abs ?? r.download_url };
  });
  log.info('video.download.done', {
    urls: input.urls.map((u) => new URL(u).hostname),
    quality: q,
    ms: Date.now() - t0,
    ok_count: patched.filter((r) => r.ok).length,
    fail_count: patched.length - patched.filter((r) => r.ok).length,
    methods: patched.filter((r) => r.ok).map((r) => (r as { method?: string }).method ?? '?'),
    errors: patched.filter((r) => !r.ok).map((r) => (r as { error_code?: string }).error_code ?? '?'),
  });
  return { results: patched };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run tests/gateway/video-handlers.test.ts`
Expected: PASS —— 3 个用例全绿

- [ ] **Step 6: 跑全量回归确认老测试仍绿**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run`
Expected: 114 个老测试 + 3 个新测试 = 117 个全绿

- [ ] **Step 7: 提交**

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
git add src/gateway/video/video-handlers.ts src/gateway/mcp/mcp.ts tests/gateway/video-handlers.test.ts
git commit -m "feat(video): extract runVideoSearch / runVideoDownload pure handlers"
```

---

### Task 2: 改 mcp.ts 让 `video_search` / `video_download` MCP handler 调用新函数

**Files:**
- Modify: `src/gateway/mcp/mcp.ts` —— 替换 `server.registerTool('video_search', ...)` 与 `server.registerTool('video_download', ...)` 的内部 handler（约第 367–443 行）。
- 其它位置**不动**。

**Interfaces:**
- Consumes: `runVideoSearch` / `runVideoDownload`（来自 `./video-handlers.js`），`ServerCtx`（mcp.ts 内已有）。
- Produces: 保持现有 MCP 行为——`content: [{ type: 'text', text: JSON.stringify(...) }]` 与 `isError: true` envelope。

- [ ] **Step 1: 修改 `video_search` MCP handler**

找到 mcp.ts 第 367–406 行（`server.registerTool('video_search', ...)` 完整块），把内部 `async ({ query, platform, limit }) => { ... }` 整段替换为：

```ts
    async ({ query, platform, limit }) => {
      try {
        const res = await runVideoSearch(
          { query, platform, limit },
          { deps, video, req: ctx.req ?? ({ headers: {} } as IncomingMessage), clientHost: ctx.clientHost },
        );
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      } catch (err) {
        const code = (err as { code?: string })?.code ?? 'EMPTY_QUERY';
        log.warn('video.search.error', { query, platform: platform ?? null, code, message: (err as Error).message });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: (err as Error).message } }) }] };
      }
    },
```

**新增 import 行**（在 mcp.ts 顶部 import 区追加，不要动其它 import）：

```ts
import { runVideoSearch, runVideoDownload } from '../video/video-handlers.js';
```

注意：第 367 行 `const video = getVideoSubsystem(deps);` **保留**——handler 仍要 `video` 给 ctx 用。

- [ ] **Step 2: 修改 `video_download` MCP handler**

找到 mcp.ts 第 413–443 行（`server.registerTool('video_download', ...)` 完整块），把内部 `async ({ urls, quality }) => { ... }` 整段替换为：

```ts
    async ({ urls, quality }) => {
      const { results } = await runVideoDownload(
        { urls, quality },
        { deps, video, req: ctx.req ?? ({ headers: {} } as IncomingMessage), clientHost: ctx.clientHost },
      );
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    },
```

**关键不变量**：
- MCP download 路径原本是**不带** try/catch 的（出错了就让 MCP SDK 抛）——保留这个行为，新代码也**不带** try/catch。
- MCP download 不重写日志字符串、不重写 `t0` 计时——这些都搬到了 `runVideoDownload` 里（见 Task 1）。
- 不动 `description` 字符串、不动 `inputSchema`。

- [ ] **Step 3: 跑全量测试确认 MCP 行为不变**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run`
Expected: 117 个测试全绿（`mcp.video.test.ts` 不动，应继续通过）

- [ ] **Step 4: 视觉比对 MCP handler 字节数**

打开 mcp.ts，确认 `video_search` 与 `video_download` 两个 handler 现在的总字节数 < 原版的 30%。如果接近原版，说明没抽干净。

- [ ] **Step 5: 提交**

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
git add src/gateway/mcp/mcp.ts
git commit -m "refactor(mcp): route video_search/video_download through shared video-handlers"
```

---

### Task 3: 改 `src/gateway/api/rest.ts` 加 `/video/search` 与 `/video/download` 路由

**Files:**
- Modify: `src/gateway/api/rest.ts` —— `createRestHandler` 签名加可选第二形参；try 块内新增两段路由。

**Interfaces:**
- Consumes:
  - `runVideoSearch` / `runVideoDownload`（来自 `../video/video-handlers.js`）
  - `VideoSubsystem`（来自 `../mcp/mcp.js`）
  - 现有 `err()` / `ok()` helpers（rest.ts 内）
- Produces:
  - 新签名 `export function createRestHandler(deps: Deps, video?: { search: typeof runVideoSearch; download: typeof runVideoDownload; subsystem: VideoSubsystem })`
  - 新增两条 POST 路由：`/video/search`、`/video/download`

- [ ] **Step 1: 修改 `createRestHandler` 签名**

找到 rest.ts 第 55 行：

```ts
export function createRestHandler(deps: Deps) {
```

改为：

```ts
export function createRestHandler(
  deps: Deps,
  video?: {
    search: typeof import('../video/video-handlers.js').runVideoSearch;
    download: typeof import('../video/video-handlers.js').runVideoDownload;
    subsystem: import('../mcp/mcp.js').VideoSubsystem;
  },
) {
```

**说明**：用 `typeof import(...)` 是为了避免循环引用（rest.ts 不依赖 mcp.ts 的运行时，仅通过类型引用 VideoSubsystem；视频 handler 本身已通过动态查找使用）。

- [ ] **Step 2: 在 rest.ts 顶部加 imports**

在现有 `import type { TempStore } from '../video/temp-store.js';` 之后追加：

```ts
import { runVideoSearch, runVideoDownload } from '../video/video-handlers.js';
import type { VideoSubsystem } from '../mcp/mcp.js';
```

- [ ] **Step 3: 在 try 块内 `/login` 路由之后追加 `/video/*` 路由**

找到 rest.ts 第 145 行（`if (method === 'POST' && path === '/login')` 整段结束后的 `}` 之前），插入：

```ts
      if (method === 'POST' && path === '/video/search') {
        if (!video) return err(res, 503, 'unavailable', 'video subsystem not configured');
        const b = await readBody(req);
        const { query, platform, limit } = b ?? {};
        if (typeof query !== 'string' || !query.trim()) {
          return err(res, 400, 'bad_args', 'query is required');
        }
        if (limit !== undefined && (typeof limit !== 'number' || limit < 1 || limit > 30)) {
          return err(res, 400, 'bad_args', 'limit must be 1..30');
        }
        if (platform !== undefined && platform !== 'all' && !/^(bilibili|youtube|douyin|tiktok|instagram|xiaohongshu|weibo|twitter)$/.test(platform)) {
          return err(res, 400, 'INVALID_PLATFORM', `unknown platform: ${platform}`);
        }
        try {
          const data = await runVideoSearch(
            { query, platform, limit },
            { deps, video: video.subsystem, req, clientHost: extractHost(req) },
          );
          return ok(res, data);
        } catch (e) {
          const code = (e as { code?: string })?.code ?? 'EMPTY_QUERY';
          if (code === 'INVALID_PLATFORM') return err(res, 400, code, (e as Error).message);
          if (code === 'EMPTY_QUERY') return err(res, 400, code, (e as Error).message);
          log.error('rest.video.search.error', { message: (e as Error).message });
          return err(res, 500, 'internal', (e as Error).message);
        }
      }
      if (method === 'POST' && path === '/video/download') {
        if (!video) return err(res, 503, 'unavailable', 'video subsystem not configured');
        const b = await readBody(req);
        const { urls, quality } = b ?? {};
        if (!Array.isArray(urls) || urls.length < 1 || urls.length > 3) {
          return err(res, 400, 'bad_args', 'urls must be an array of 1..3 items');
        }
        if (!urls.every((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u))) {
          return err(res, 400, 'bad_args', 'every url must be http(s)');
        }
        if (quality !== undefined && !['best', '1080p', '720p', '480p', 'worst'].includes(quality)) {
          return err(res, 400, 'bad_args', `unknown quality: ${quality}`);
        }
        try {
          const data = await runVideoDownload(
            { urls, quality },
            { deps, video: video.subsystem, req, clientHost: extractHost(req) },
          );
          return ok(res, data);
        } catch (e) {
          log.error('rest.video.download.error', { message: (e as Error).message });
          return err(res, 500, 'internal', (e as Error).message);
        }
      }
```

**关键不变量**：
- 鉴权分支（rest.ts 第 82–85 行）**不动**——新路由自动受 `Bearer` 保护。
- `/health`、`/sites`、`/sites/:site/help`、`/run`、`/login`、`/files/:id` **一字不动**。
- 错误码 `EMPTY_QUERY` / `INVALID_PLATFORM` 与 MCP 路径一致——这两条专门在 catch 里翻译成 400；其它抛错 → 500。

- [ ] **Step 4: 跑全量测试确认老测试仍绿**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run`
Expected: 117 个测试全绿（rest.test.ts 不动）

- [ ] **Step 5: 提交**

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
git add src/gateway/api/rest.ts
git commit -m "feat(api): add POST /video/search and POST /video/download routes"
```

---

### Task 4: 改 `src/gateway/mcp/index.ts` 装配 video handler 进 REST 路由

**Files:**
- Modify: `src/gateway/mcp/index.ts` —— 导入 handler + subsystem；调 `createRestHandler` 时传入第二个参数。

**Interfaces:**
- Consumes: `runVideoSearch` / `runVideoDownload`（来自 `../video/video-handlers.js`），`getVideoSubsystem`（来自 `./mcp.js`）。
- Produces: HTTP server 在 `/video/search`、`/video/download` 上提供 REST 路由。

- [ ] **Step 1: 修改 mcp/index.ts 加 imports**

找到 mcp/index.ts 顶部现有 import 区（第 1–12 行附近），在最后追加：

```ts
import { runVideoSearch, runVideoDownload } from '../video/video-handlers.js';
import { getVideoSubsystem } from './mcp.js';
```

- [ ] **Step 2: 修改 `createRestHandler` 调用**

找到 mcp/index.ts 第 42 行：

```ts
const rest = createRestHandler(deps);
```

改为：

```ts
const videoSubsystem = getVideoSubsystem(deps);
const rest = createRestHandler(deps, {
  search: runVideoSearch,
  download: runVideoDownload,
  subsystem: videoSubsystem,
});
```

- [ ] **Step 3: 跑全量测试**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run`
Expected: 117 个测试全绿

- [ ] **Step 4: 视觉核对 index.ts 没改其它行**

确认 `/mcp` 路由块、auth 头、HTTP server 监听、TempStore 装配全部不动。

- [ ] **Step 5: 提交**

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
git add src/gateway/mcp/index.ts
git commit -m "feat(gateway): wire video subsystem into REST handler"
```

---

### Task 5: 新建 `tests/gateway/rest.video.test.ts` 端到端覆盖 §6 测试矩阵 + 部署

**Files:**
- Create: `tests/gateway/rest.video.test.ts`
- Deploy: 本地 `npm run build` → 快速 scp 路径或 CI 路径（见下文）。

**Interfaces:**
- Consumes: `createRestHandler`（来自 `../../src/gateway/api/rest.js`），`runVideoSearch` / `runVideoDownload`。
- Produces: 11 个新 vitest 用例覆盖 spec §6 测试矩阵。

- [ ] **Step 1: 写 `tests/gateway/rest.video.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRestHandler } from '../../src/gateway/api/rest.js';
import { runVideoSearch, runVideoDownload, type VideoHandlerCtx } from '../../src/gateway/video/video-handlers.js';
import type { Deps } from '../../src/gateway/api/rest.js';
import type { Manifest } from '../../src/gateway/core/manifest.js';
import type { Config } from '../../src/gateway/core/config.js';
import type { VideoSubsystem } from '../../src/gateway/mcp/mcp.js';
import { TempStore } from '../../src/gateway/video/temp-store.js';

function makeManifest(): Manifest {
  return {
    getSiteHelp: vi.fn().mockReturnValue([]),
    listSites: vi.fn().mockReturnValue([]),
    searchSites: vi.fn().mockReturnValue([]),
  } as unknown as Manifest;
}

function makeCfg(tmpDir: string, apiKey = 'test-key'): Config {
  return {
    apiKey,
    manifestPath: '/tmp/m.json',
    tmpDir,
    logDir: '/tmp',
    logLevel: 'info',
    cookieDir: '/tmp',
    outputDir: '/tmp',
    proxyUrl: null,
  };
}

interface ResSpy {
  res: any;
  status: number;
  body: any;
  writeHead: (s: number) => void;
  setHeader: (k: string, v: string) => void;
  end: (b: string) => void;
}

function makeRes(): ResSpy {
  const spy: ResSpy = {
    res: undefined as any,
    status: 0,
    body: undefined,
    writeHead: function (s: number) { this.status = s; },
    setHeader: function (k: string, v: string) { /* no-op */ },
    end: function (b: string) { this.body = b ? JSON.parse(b) : undefined; },
  };
  spy.res = spy;
  return spy;
}

function makeReq(opts: { method: string; url: string; body?: any; headers?: Record<string, string> }): import('node:http').IncomingMessage {
  const raw = opts.body !== undefined ? JSON.stringify(opts.body) : '';
  const r: any = {
    method: opts.method,
    url: opts.url,
    headers: Object.assign({ host: 'gateway.local' }, opts.headers || {}),
  };
  // Readable stream-like
  (async function* () { if (raw) yield raw; })().toArray = () => Promise.resolve([Buffer.from(raw)]);
  // Provide a simple async iterator on r
  r[Symbol.asyncIterator] = async function* () { if (raw) yield raw; };
  return r as import('node:http').IncomingMessage;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rest-video-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

describe('REST /video/* auth + happy path', () => {
  let video: VideoSubsystem;
  let deps: Deps;
  let handler: ReturnType<typeof createRestHandler>;

  beforeEach(async () => {
    await withTmpDir(async (tmpDir) => {
      video = {
        pool: { downloadMany: vi.fn() } as unknown as VideoSubsystem['pool'],
        fetchCookies: vi.fn(),
      };
      deps = {
        cfg: makeCfg(tmpDir, 'test-key'),
        manifest: makeManifest(),
        run: vi.fn(),
        vnc: vi.fn(),
        tempStore: new TempStore({ tmpDir, ttlMs: 60_000 }),
      };
      handler = createRestHandler(deps, {
        search: runVideoSearch,
        download: runVideoDownload,
        subsystem: video,
      });
    });
  });

  it('rejects unauthenticated POST /video/search with 401', async () => {
    const req = makeReq({ method: 'POST', url: '/video/search', body: { query: 'x' } });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('search returns 200 with results + stats', async () => {
    deps.run = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ id: 'BV1', title: 't', url: 'https://www.bilibili.com/video/BV1' }],
    });
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: 'x' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data.results)).toBe(true);
    expect(Array.isArray(res.body.data.stats.succeeded)).toBe(true);
  });

  it('search 400 EMPTY_QUERY on empty query', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: '' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMPTY_QUERY');
  });

  it('search 400 INVALID_PLATFORM on bogus platform', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: 'x', platform: 'bogus' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PLATFORM');
  });

  it('search 400 bad_args when query missing', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: {},
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('download returns 200 with patched absolute download_url', async () => {
    (video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        url: 'https://x/y',
        ok: true,
        method: 'ytdlp',
        filename: 'video_abc.mp4',
        size_bytes: 1024,
        download_url: '/files/abc.mp4',
        expires_at: '2099-01-01T00:00:00Z',
      },
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://x/y'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].download_url).toMatch(/^http:\/\/gateway\.local\/files\/abc\.mp4$/);
  });

  it('download 400 bad_args on urls missing', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: {},
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('download 400 bad_args on urls > 3', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('download propagates per-URL failure as results[].ok=false', async () => {
    (video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        url: 'https://x/y',
        ok: false,
        error_code: 'LOGIN_REQUIRED',
        error_message: 'sign in to confirm you’re not a bot',
      },
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://x/y'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].ok).toBe(false);
    expect(res.body.data.results[0].error_code).toBe('LOGIN_REQUIRED');
  });

  it('download 500 internal on pool throw', async () => {
    (video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://x/y'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
  });

  it('search 500 internal on searchVideos throw', async () => {
    deps.run = vi.fn().mockRejectedValue(new Error('kaboom'));
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: 'x' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
  });
});
```

- [ ] **Step 2: 跑新测试**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run tests/gateway/rest.video.test.ts`
Expected: PASS —— 11 个新用例全绿

- [ ] **Step 3: 跑全量回归**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx vitest run`
Expected: 114 个老测试 + 14 个新测试（3 video-handlers + 11 rest.video）= 128 个全绿

- [ ] **Step 4: TypeScript 类型检查**

Run: `cd "D:/programming/projects/my project/camofox/camofox-opencli" && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
git add tests/gateway/rest.video.test.ts
git commit -m "test(rest): cover POST /video/search and /video/download"
```

---

## Deployment

按现有两条路径二选一：

### 路径 A：CI（tag 触发）

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
git tag v0.2.6
git push origin main
git push origin v0.2.6
# 等待 CI build + push ghcr.io/fectivnfy112357/camofox-opencli:v0.2.6
# 服务器：
ssh -i ~/.ssh/textvision_top_id_ed25519 root@textvision.top -p 54751 \
  "cd /opt && docker compose pull camofox && docker compose up -d --force-recreate camofox"
```

### 路径 B：快速 scp（seconds）

```bash
cd "D:/programming/projects/my project/camofox/camofox-opencli"
npm run build
scp dist/gateway/video/video-handlers.js \
    dist/gateway/api/rest.js \
    dist/gateway/mcp/mcp.js \
    dist/gateway/mcp/index.js \
    root@textvision.top:/tmp/gateway-dist/

ssh -i ~/.ssh/textvision_top_id_ed25519 root@textvision.top -p 54751 \
  "docker cp /tmp/gateway-dist/video-handlers.js camofox:/opt/gateway/dist/gateway/video/video-handlers.js && \
   docker cp /tmp/gateway-dist/rest.js camofox:/opt/gateway/dist/gateway/api/rest.js && \
   docker cp /tmp/gateway-dist/mcp.js camofox:/opt/gateway/dist/gateway/mcp/mcp.js && \
   docker cp /tmp/gateway-dist/index.js camofox:/opt/gateway/dist/gateway/mcp/index.js && \
   docker exec camofox kill -HUP \$(pgrep -f 'gateway/mcp/index.js')"
# supervisord autorestart 会拉起新进程
```

部署后**最低限度冒烟**：

```bash
# 健康
curl -s http://textvision.top:8080/health
# REST 搜索（替换 <KEY> 为 GATEWAY_API_KEY）
curl -s -X POST http://textvision.top:8080/video/search \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"query":"test"}' | head -c 500
# REST 下载（占位 URL，看返回结构）
curl -s -X POST http://textvision.top:8080/video/download \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"urls":["https://www.youtube.com/watch?v=jNQXAC9IVRw"]}'
```

预期：search 返回 `results` 数组（哪怕部分平台失败）；download 返回 `results[0].download_url` 是 `http://textvision.top:8080/files/...` 形式。

---

## Self-Review

按 skill 要求做一遍：

**1. Spec 覆盖**：spec §3 三个端点 → Task 3 + Task 4；spec §4 架构 → Task 1；spec §5 文件改动清单 → Task 1/2/3/4/5 各自对应；spec §6 测试矩阵 11 行 → Task 5 共 11 个 it()。无 gap。

**2. 占位符扫描**：扫一遍无 `TBD` / `TODO` / `fill in`。所有 step 都有具体代码块或具体命令。

**3. 类型一致性**：
- `runVideoSearch` / `runVideoDownload` 在 Task 1 定义，Task 2/3/5 全部按此调用，签名一致。
- `VideoHandlerCtx.deps` / `video` / `req` / `clientHost` 在 Task 1 定义，Task 2/3/5 全部按字段命名传入。
- `VideoSubsystem` 在 Task 1 Step 3 导出，Task 4 Step 2 装配、Task 5 Step 1 测试 fixture 全部按导出类型使用。
- `createRestHandler(deps, video?)` 第二形参在 Task 3 Step 1 定义，Task 4 Step 2 与 Task 5 Step 1 都按 `{ search, download, subsystem }` 形态传入。

无不一致。

---

## Plan Self-Review 复检

我刚又扫了一遍本计划与 spec：

1. **Task 1 Step 4 中 `runVideoSearch` 内部 `catch` 把 `code` 透传给上层** —— 没问题，REST 路径在 Task 3 Step 3 用了同一 `code` 字段做 400 翻译。
2. **Task 3 Step 3 `EMPTY_QUERY` 的 400 翻译** —— spec §3 列的 `EMPTY_QUERY` 与 `INVALID_PLATFORM` 是两种 code；Task 3 都已处理。
3. **Task 5 测试用例的 `req` 构造** —— 用 async iterator 模拟 IncomingMessage body stream，rest.ts 现有 `readBody` 用 `for await (const c of req)` 读取，能解析。

无新增问题。