# Video Search / Download REST API 设计

- **日期**：2026-07-23
- **范围**：把网关里现有的 MCP 工具 `video_search` / `video_download` 暴露为 REST 端点，供 MCP 客户端之外的客户端调用。
- **不变量**：MCP 路径行为字节级保持不变；`/files/:id`、现有 REST 路由保持不变；现有 114 个测试全部不动。

## 1. 背景

camofox-opencli 网关在 `:8080/mcp` 上用 streamable-HTTP/JSON-RPC 暴露了两个视频工具：

- `video_search(query, platform?, limit?)`：跨平台 fan-out 搜索。
- `video_download(urls[], quality?)`：用 yt-dlp 下载 1–3 个视频，返回 `/files/<id>` 临时 URL（1 小时 TTL）。

只通过 MCP 暴露意味着只有 MCP 客户端能调用。需要在同一容器内、同一进程上、同一业务代码路径上新增两个 REST 端点，让浏览器扩展、CLI 脚本、第三方服务等都能调用。

## 2. 设计目标

1. REST 与 MCP 共享同一份业务逻辑（`searchVideos` / `DownloadPool`），行为一致。
2. 不修改 MCP handler 的字节序列——日志、错误码、envelope 形状全部保持现状。
3. 与现有 REST 一致的鉴权、错误格式、Content-Type。
4. 新增 vitest 单测覆盖新端点，老测试不动。

## 3. 端点契约

### `POST /video/search`

```
Headers:
  Authorization: Bearer <GATEWAY_API_KEY>     （当 cfg.apiKey 非空时必带）
  Content-Type: application/json

Body:
  {
    "query":   string,                 // 非空
    "platform": string?,               // bilibili|youtube|douyin|tiktok|instagram|xiaohongshu|weibo|twitter|"all"
    "limit":    number?                // 1..30，默认 10
  }

Responses:
  200  { results: VideoSearchResult[], stats: { requested_platforms: string[], succeeded: VideoSite[], failed: Array<{platform, error}> } }
  400  { ok: false, error: { code: "EMPTY_QUERY"|"INVALID_PLATFORM"|"bad_args", message } }
  401  { ok: false, error: { code: "unauthorized", message } }
  500  { ok: false, error: { code: "internal", message } }
```

### `POST /video/download`

```
Headers:
  Authorization: Bearer <GATEWAY_API_KEY>
  Content-Type: application/json

Body:
  {
    "urls":    string[],              // 1..3 项，每项必须 http/https URL
    "quality": "best"|"1080p"|"720p"|"480p"|"worst"?   // 默认 best
  }

Responses:
  200  { results: VideoDownloadResult[] }    // 元素 ok:true 时含 download_url（绝对 URL）、filename、size_bytes、expires_at；ok:false 时含 error_code、error_message
  400  { ok: false, error: { code: "bad_args", message } }   // urls 缺失、超 3 个、非 http/https 等统一在此码下
  401  { ok: false, error: { code: "unauthorized", message } }
  500  { ok: false, error: { code: "internal", message } }
```

### `GET /files/:id`（沿用现状，不变）

免鉴权；返回二进制视频流；404/503/405 沿用现状。

## 4. 架构

```
HTTP request
  │
  ├─ path=/mcp               → 现有 MCP JSON-RPC 路径（不变）
  └─ path=/video/* 或 /files/* → createRestHandler
                                    │
                                    ├─ /video/search  → runVideoSearch(input, ctx) → searchVideos(...)
                                    ├─ /video/download→ runVideoDownload(input, ctx) → pool.downloadMany(...)
                                    └─ /files/:id     → 现有 TempStore 取文件（不变）
```

### 共享代码

新建 `src/gateway/video/video-handlers.ts`，导出：

```ts
export interface VideoHandlerCtx {
  deps: Deps;                  // 现有 api/rest.ts 的 Deps
  video: VideoSubsystem;       // 现有 mcp.ts 内部的 VideoSubsystem（pool + fetchCookies）
  req: IncomingMessage;        // 用于 buildAbsoluteUrl
  clientHost: string | null;   // 仅日志上下文
}

export async function runVideoSearch(
  input: { query: string; platform?: string; limit?: number },
  ctx: VideoHandlerCtx,
): Promise<VideoSearchResponse>;

export async function runVideoDownload(
  input: { urls: string[]; quality?: string },
  ctx: VideoHandlerCtx,
): Promise<{ results: VideoDownloadResult[] }>;
```

两个函数的实现**逐字**对应 `src/gateway/mcp/mcp.ts` 中 video_search / video_download handler 的现有逻辑：start/done 日志、错误捕获、`routerDeps` 构造（search）、`buildAbsoluteUrl` 包装（download），全部一一对应，不删减、不改写。返回值是裸对象，不含 MCP envelope。

## 5. 文件改动清单

### 新增

- `src/gateway/video/video-handlers.ts`：上面导出的两个函数 + `VideoHandlerCtx` 类型。
- `tests/gateway/rest.video.test.ts`：vitest 单测，覆盖 §6 测试矩阵。

### 修改

- `src/gateway/mcp/mcp.ts`：
  - 引入 `runVideoSearch` / `runVideoDownload`。
  - 把 `server.registerTool('video_search', ...)` 内部 handler 改为 `await runVideoSearch(input, ctx)` 然后用 MCP envelope 包装 `{ content: [{ type: 'text', text: JSON.stringify(res) }] }`。
  - 把 `server.registerTool('video_download', ...)` 同样改写。
  - `VideoSubsystem`、`getVideoSubsystem`、`_video` 单例、所有日志字符串、错误码字符串**全部保持不变**。
- `src/gateway/mcp/index.ts`：
  - 导入 `runVideoSearch` / `runVideoDownload`，构造 `videoSubsystem = getVideoSubsystem(deps)`，把两个 handler 与 subsystem 注入到 `createRestHandler(deps, { video: { search, download } })`。
  - 现有 HTTP server、`/mcp` 路由、auth 头、`/files/:id`、`/health`、supervisord 全部**不动**。
- `src/gateway/api/rest.ts`：
  - `createRestHandler` 新增可选第二形参 `video?: { search, download, subsystem }`（实现期采用此方案；不新建独立 handler 链）。
  - 在 try 块内新增：
    - `if (method === 'POST' && path === '/video/search')`：读 body → 校验 `query`/`platform`/`limit` → 调 `video.search` → `ok(res, data)`。
    - `if (method === 'POST' && path === '/video/download')`：读 body → 校验 `urls`/`quality` → 调 `video.download` → `ok(res, data)`。
  - 鉴权分支、`/run`、`/login`、`/sites*`、`/health`、`/files/:id` 全部**不动**。
  - 错误响应通过现有的 `err(res, status, code, message)` helper 输出，与 `/run` 路径一致。

### 不修改

- `src/gateway/video/video-router.ts`、`video-cookies.ts`、`download-pool.ts`、`temp-store.ts`、`url-builder.ts`、`video-types.ts`：业务逻辑零改动。
- `src/gateway/core/*`：不动。
- `tests/gateway/mcp.video.test.ts`、`rest.test.ts`、`rest.files.test.ts`：不动。

## 6. 测试矩阵

新建 `tests/gateway/rest.video.test.ts`，用 vitest + mock `deps.run` / mock `pool.downloadMany` 触发各分支。`Deps` mock 与 `mcp.video.test.ts` 同款（`Config` 字段包含 `apiKey/logDir/logLevel/tmpDir/cookieDir/outputDir/proxyUrl`）。`deps.run` mock 返回 `{ ok: true, data: [...] }`（MCP 路径同形态）。

| 用例 | 入参 / Mock | 期望 |
|---|---|---|
| 鉴权失败 | 无 Authorization header，合法 body | 401 + `error.code='unauthorized'` |
| search 全平台成功 | `query:"x"`，mock deps.run 全部返回 ok | 200 + `results` 非空，`stats.succeeded` 含三个默认平台 |
| search 单平台失败 | `query:"x"`，mock youtube 返回 ok:false | 200 + `stats.failed` 含 youtube |
| search 空 query | `query:""` | 400 + `error.code='EMPTY_QUERY'` |
| search 非法 platform | `query:"x", platform:"bogus"` | 400 + `error.code='INVALID_PLATFORM'` |
| search body 缺 query | `{}` | 400 + `error.code='bad_args'` |
| download 成功 | `urls:["https://x/y"]`，mock pool 返回 ok:true | 200 + `download_url` 是绝对 URL（基于 host header） |
| download urls 缺失 | `{}` | 400 + `error.code='bad_args'` |
| download urls 超 3 个 | `urls:[4 个]` | 400 + `error.code='bad_args'` |
| download 单 URL 失败 | mock pool 返回 ok:false | 200 + `results[0].ok=false`，`error_code` 透传 |
| download 内部异常 | mock pool throw | 500 + `error.code='internal'` |

目标：`npm test` 全绿（现有 114 个测试 + 新增的 ~11 个）。

## 7. 部署

按现有"快速部署"路径：`npm run build` → `scp dist/gateway/video/video-handlers.js` + `dist/gateway/mcp/index.js` + `dist/gateway/mcp/mcp.js` + `dist/gateway/api/rest.js` → `docker cp` → supervisord autorestart。

或：commit + push + tag → CI 走 `Dockerfile.publish` 重建并 publish 到 `ghcr.io/fectivnfy112357/camofox-opencli`，服务器 `docker compose pull && up -d --force-recreate`。

## 8. 不在范围内（YAGNI）

- API 版本化（`/v1/video/*`）——目前只一个版本，等客户端多了再加。
- 速率限制、批量并发令牌——MCP 也没有，统一由 supervisord + 单进程 Node 限流。
- 流式响应（SSE）——`/video/download` 当前是同步返回 results 数组，下载本身异步发生在 yt-dlp 进程内。
- 公开 video-only 鉴权（`VIDEO_API_KEY`）——复用 `GATEWAY_API_KEY`。