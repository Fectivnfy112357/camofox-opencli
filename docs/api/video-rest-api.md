# Video REST API

camofox-opencli 网关在 `http://<host>:8080` 上提供以下两个视频相关 REST 端点，与 MCP 工具 `video_search` / `video_download` 共享同一份业务代码。

## 公共约定

### Base URL

```
http://textvision.top:9378
```

> 容器内调用可用 `http://127.0.0.1:8080`，经由反向代理公开时使用 `https://textvision.top:9378`。两种形式等效。

### 鉴权

除 `GET /health` 与 `GET /files/:id` 外，所有端点都需要 `Authorization` header：

```
Authorization: Bearer <GATEWAY_API_KEY>
```

`<GATEWAY_API_KEY>` 在部署时通过 `docker-compose.yml` 的环境变量注入；默认值 `change_me_gateway_key`，**生产部署必须替换**。

### Content-Type

请求与响应统一使用 `application/json`。UTF-8 编码。

### 通用响应格式

成功响应：

```json
{ "ok": true, "data": <T> }
```

错误响应：

```json
{ "ok": false, "error": { "code": "<string>", "message": "<string>" } }
```

| HTTP status | `error.code` 含义 | 何时出现 |
|---|---|---|
| 400 | `bad_args` / `EMPTY_QUERY` / `INVALID_PLATFORM` | 客户端参数错误 |
| 401 | `unauthorized` | 缺 / 错 Bearer |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 路径不允许该方法 |
| 500 | `internal` | 网关内部异常 |
| 502 | `opencli_error` | 下游 opencli 调用失败 |
| 503 | `unavailable` | video subsystem 未配置（理论上不会触发，除非注入失败） |

---

## `POST /video/search`

跨平台视频搜索，并发查询最多 3 个站点；单平台失败不会中断整次请求，结果通过 `stats.failed` 反馈。

### 请求

**Headers**

| Header | 必需 | 说明 |
|---|---|---|
| `Authorization` | 是 | `Bearer <GATEWAY_API_KEY>` |
| `Content-Type` | 是 | `application/json` |

**Body 参数**

| 字段 | 类型 | 必需 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | 是 | — | 搜索关键词；非空字符串 |
| `platform` | string | 否 | `bilibili, youtube, tiktok` | 单个站点名（见下表）、`"all"`（8 站点全搜）或省略 |
| `limit` | integer | 否 | `10` | **每个平台**返回的结果数（`1..30`），**不是全局总条数**；实际 `data.results.length = limit × succeeded 平台数` |

**`platform` 取值**

| 值 | 行为 |
|---|---|
| 省略 | 默认三站点：`bilibili`、`youtube`、`tiktok` |
| `"all"` | 8 站点全搜：`bilibili`、`youtube`、`douyin`、`tiktok`、`instagram`、`xiaohongshu`、`weibo`、`twitter` |
| `"bilibili"` / `"youtube"` / `"douyin"` / `"tiktok"` / `"instagram"` / `"xiaohongshu"` / `"weibo"` / `"twitter"` | 只搜这一个站点 |
| 其它字符串 | 400 + `INVALID_PLATFORM` |

### 响应

**200 OK**

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "platform": "bilibili",
        "id": "BV1xx411c7mH",
        "title": "示例视频标题",
        "url": "https://www.bilibili.com/video/BV1xx411c7mH",
        "author": "示例UP主",
        "duration": "10:32",
        "views": 12345,
        "thumbnail": "https://i0.hdslb.com/bfs/cover/xxx.jpg"
      }
    ],
    "stats": {
      "requested_platforms": ["bilibili", "youtube", "tiktok"],
      "succeeded": ["bilibili", "youtube"],
      "failed": [
        { "platform": "tiktok", "error": "AUTH_REQUIRED" }
      ]
    }
  }
}
```

`results` 中每条 `VideoSearchResult`：

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| `platform` | string | 是 | 站点名（与 `platform` 入参同集） |
| `id` | string | 是 | 站点内唯一 id（如 BV 号 / YouTube videoId） |
| `title` | string | 是 | 视频标题 |
| `url` | string | 是 | 可直接访问的视频页 URL |
| `author` | string | 否 | UP 主 / 频道名 |
| `duration` | string | 否 | 时长（格式因站点而异：`"10:32"` 或 `"1:23:45"`） |
| `views` | integer | 否 | 播放数 / 热度 |
| `thumbnail` | string | 否 | 封面 URL |

`stats`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requested_platforms` | string[] | 本次实际查询的站点列表 |
| `succeeded` | string[] | 至少返回一条结果的站点 |
| `failed` | Array<{platform, error}> | 失败的站点及错误信息（鉴权失败 / 网络异常等） |

**400 / 401 / 500**：见上文公共约定。典型场景：

- `query=""` 或缺失 → 400 `bad_args`
- `platform="bogus"` → 400 `INVALID_PLATFORM`
- `limit=0` 或 `limit=31` → 400 `bad_args`

### 完整 curl 例子

```bash
# 1) 默认三站点搜索
curl -sS -X POST http://textvision.top:8080/video/search \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"query":"python tutorial"}'

# 2) 单站点
curl -sS -X POST http://textvision.top:8080/video/search \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"query":"demo","platform":"youtube","limit":5}'

# 3) 全站点
curl -sS -X POST http://textvision.top:8080/video/search \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"query":"news","platform":"all","limit":3}'

# 4) 错误：INVALID_PLATFORM
curl -sS -X POST http://textvision.top:8080/video/search \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"query":"x","platform":"bogus"}'
# → 400 {"ok":false,"error":{"code":"INVALID_PLATFORM","message":"unknown platform: bogus"}}
```

### 性能提示

- 整次请求耗时 ≈ 最慢单站点的查询耗时（并发 3 路）。
- 默认三站点一般在 3–10 秒；`platform="all"` 全部 8 站点并发 3 路，约 15–30 秒。
- 单平台失败不会拖慢整体——失败的站点即时进入 `stats.failed`，不重试。
- **`results.length` 上限**：`limit × len(stats.succeeded)`。例：`platform=all`、`limit=5` → 最多 40 条；5 平台成功 → 实得 25 条。

---

## `POST /video/download`

下载 1–3 个视频到容器内的临时目录，注册到 `TempStore`（1 小时 TTL），返回可在 `GET /files/:id` 上读取的临时 URL。

### 请求

**Headers**

| Header | 必需 | 说明 |
|---|---|---|
| `Authorization` | 是 | `Bearer <GATEWAY_API_KEY>` |
| `Content-Type` | 是 | `application/json` |

**Body 参数**

| 字段 | 类型 | 必需 | 默认 | 说明 |
|---|---|---|---|---|
| `urls` | string[] | 是 | — | 1–3 个视频页 URL；每个必须以 `http://` 或 `https://` 开头 |
| `quality` | enum | 否 | `best` | 见下表 |

**`quality` 取值**

| 值 | yt-dlp 格式选择器 | 适用场景 |
|---|---|---|
| `"best"` | `bv*+ba/b` | 默认：最佳视频流 + 最佳音频流（合并），fallback 到最佳单一文件 |
| `"1080p"` | `bv*[height<=1080]+ba/b[height<=1080]` | 限制最高 1080p |
| `"720p"` | `bv*[height<=720]+ba/b[height<=720]` | 限制最高 720p |
| `"480p"` | `bv*[height<=480]+ba/b[height<=480]` | 限制最高 480p |
| `"worst"` | `worst` | 最低质量，单一文件 |

### 响应

**200 OK**

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "ok": true,
        "method": "ytdlp",
        "filename": "video_550e8400-e29b-41d4-a716-446655440000.mp4",
        "size_bytes": 486000,
        "download_url": "http://textvision.top:8080/files/550e8400-e29b-41d4-a716-446655440000.mp4",
        "expires_at": "2026-07-23T04:20:00.000Z"
      },
      {
        "url": "https://www.bilibili.com/video/BV1xx",
        "ok": false,
        "error_code": "LOGIN_REQUIRED",
        "error_message": "Sign in to confirm you're not a bot"
      }
    ]
  }
}
```

每条 `VideoDownloadResult` 字段：

| 字段 | 类型 | 出现于 | 说明 |
|---|---|---|---|
| `url` | string | 始终 | 原始请求 URL（用于客户端关联） |
| `ok` | boolean | 始终 | `true` = 下载成功；`false` = 失败 |
| `method` | `"ytdlp"` \| `"camofox"` | `ok=true` | 实际使用的下载路径（douyin 走 camofox，其它平台走 yt-dlp） |
| `filename` | string | `ok=true` | 容器内临时文件名 |
| `size_bytes` | integer | `ok=true` | 文件字节数 |
| `download_url` | string | `ok=true` | **绝对 URL**，可直接 GET 获取文件；基于请求 Host header 生成 |
| `expires_at` | string (ISO8601) | `ok=true` | TTL 过期时间（请求完成后 +1 小时） |
| `error_code` | string | `ok=false` | 错误码（见下表） |
| `error_message` | string | `ok=false` | 错误详情（首 500 字符） |

**`error_code` 取值**

| Code | 含义 |
|---|---|
| `INVALID_URL` | URL 格式非法或非 http/https |
| `URLS_TOO_MANY` | urls 数组超 3 个（实际上由 REST 校验提前返回 `bad_args`，仅当直接调用底层 handler 时会出现） |
| `LOGIN_REQUIRED` | 站点要求登录；当前 cookie 无法绕过 |
| `YT_DLP_FAILED` | yt-dlp 进程退出码非 0 |
| `CAMOFOX_DOWNLOAD_FAILED` | douyin 走 camofox 路径下载失败 |
| `COOKIE_FETCH_FAILED` | 从 Camofox 拉取 cookie 失败 |
| `WORKER_TIMEOUT` | 下载超时（默认 10 分钟） |
| `DISK_FULL` | 容器磁盘满 |
| `RATE_LIMITED` / `PAID_CONTENT` | 站点返回 429 / 付费墙 |
| `NATIVE_DOWNLOAD_FAILED` | 旧的 native 路径失败码（保留字段，当前未触发） |

### 取文件

`download_url` 是一小时内有效的绝对 URL，无需再带 Bearer：

```bash
curl -O -J http://textvision.top:8080/files/550e8400-e29b-41d4-a716-446655440000.mp4
```

`-J` 让 curl 使用服务器返回的 `Content-Disposition` 文件名；`-O` 保留原始扩展名。

文件过期后请求返回 404 `not_found`。

### 完整 curl 例子

```bash
# 1) 单 URL 下载
curl -sS -X POST http://textvision.top:8080/video/download \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://www.youtube.com/watch?v=jNQXAC9IVRw"]}'

# 2) 三个 URL 并发下载，限定 720p
curl -sS -X POST http://textvision.top:8080/video/download \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      "https://www.bilibili.com/video/BV1xx",
      "https://www.douyin.com/video/7660110395654294810"
    ],
    "quality": "720p"
  }'

# 3) 错误：urls 缺失
curl -sS -X POST http://textvision.top:8080/video/download \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{}'
# → 400 {"ok":false,"error":{"code":"bad_args","message":"urls must be an array of 1..3 items"}}

# 4) 错误：URL 非 http(s)
curl -sS -X POST http://textvision.top:8080/video/download \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"urls":["ftp://example.com/v.mp4"]}'
# → 400 {"ok":false,"error":{"code":"bad_args","message":"every url must be http(s)"}}

# 5) 错误：quality 非法
curl -sS -X POST http://textvision.top:8080/video/download \
  -H "Authorization: Bearer change_me_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://x/y"],"quality":"4k"}'
# → 400 {"ok":false,"error":{"code":"bad_args","message":"unknown quality: 4k"}}

# 6) 取下载好的文件（无需 Bearer）
curl -O -J http://textvision.top:8080/files/<id>.mp4
```

### 性能与限制

- 三个 URL 并发下载，受 yt-dlp 单进程工作池限流（worker=3）。
- 单 URL yt-dlp 默认超时 10 分钟；返回 200 但 `results[i].ok=false` 时通常意味着该 URL 失败。
- `download_url` 的 host 来自客户端请求的 `Host` header（或 `X-Forwarded-Host`），因此从公网域名调用会得到公网绝对 URL，从容器内 `127.0.0.1` 调用会得到 `127.0.0.1` 形式。**跨网络调用方务必使用公网域名以保证可访问**。
- 临时文件 1 小时后自动清理（gateway 进程每 10 分钟 sweep 一次）。

---

## 其它相关端点（不在本节范围，列出便于查阅）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查，免鉴权 |
| `GET` | `/sites?q=<keyword>` | 列出已注册的 opencli 站点 |
| `GET` | `/sites/:site/help` | 列出某站点的所有命令 |
| `POST` | `/run` | 通用 opencli 命令调用 |
| `POST` | `/login` | 获取 VNC 登录链接 |
| `GET` | `/files/:id` | 取临时文件，免鉴权 |

---

## 调用样例：完整工作流

```bash
KEY="change_me_gateway_key"
BASE="http://textvision.top:8080"

# 1) 搜索
search=$(curl -sS -X POST "$BASE/video/search" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Me at the zoo","platform":"youtube","limit":3}')
echo "$search" | jq '.data.results[].url'

# 2) 拿到 url 后下载
url=$(echo "$search" | jq -r '.data.results[0].url')
dl=$(curl -sS -X POST "$BASE/video/download" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"urls\":[\"$url\"]}")

# 3) 取绝对 URL（无需 Bearer），保存到本地
download_url=$(echo "$dl" | jq -r '.data.results[0].download_url')
curl -O -J "$download_url"
```

---

## 错误排查速查

| 现象 | 检查项 |
|---|---|
| 401 `unauthorized` | Authorization header 是否以 `Bearer ` 开头；`GATEWAY_API_KEY` 是否正确 |
| 400 `bad_args` (query required) | `query` 字段是否非空字符串 |
| 400 `INVALID_PLATFORM` | `platform` 是否在 8 站点名 / `"all"` 之列 |
| 400 `bad_args` (urls 缺失) | `urls` 是否为 1–3 个元素的数组，每项 `http(s)://` |
| 200 但 `results[].ok=false` | 检查 `error_code`：`LOGIN_REQUIRED` → Camofox VNC 重新登录；`YT_DLP_FAILED` → 看容器日志 `/var/log/gateway/gateway.log` |
| `download_url` 是 `127.0.0.1` 而非公网 | 客户端没传公网 `Host` header；从公网调用就会自动纠正 |

## 变更日志

- **2026-07-23** — 新增 `/video/search` 与 `/video/download` REST 端点（commit `694b78d` → `8534648`）。行为与 MCP 工具 `video_search` / `video_download` 完全一致。