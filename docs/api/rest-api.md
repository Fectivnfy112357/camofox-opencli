# camofox-opencli HTTP API

camofox-opencli gateway 暴露在同一端口上同时托管两类端点:

- 通用 HTTP/REST(下文详细列出)
- MCP streamable HTTP at `/mcp`(MCP 客户端专用,见 [CLAUDE.md](../../CLAUDE.md)的"MCP tool quirks"节)

**Base URL**:`http://<host>:9378`
**认证**:`Authorization: Bearer <GATEWAY_API_KEY>`(默认 `change_me_gateway_key`)
**响应 envelope**(所有 endpoint):

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "<STRING>", "message": "<STRING>", ...extras } }
```

错误码随 endpoint 变,但通用约定:

| HTTP | `error.code`        | 触发条件                                        |
|------|---------------------|-------------------------------------------------|
| 400  | `bad_args`          | 必填参数缺失 / 类型不匹配                       |
| 400  | `unknown_command`   | `site` + `command` 组合在 manifest 中不存在    |
| 400  | `INVALID_PLATFORM`  | `/video/search` 的 `platform` 值非法            |
| 401  | `unauthorized`      | 缺 Bearer 或不匹配                              |
| 404  | `not_found` / `unknown_site` | URL 不匹配,或 `site` 在 manifest 中找不到 |
| 405  | `method_not_allowed`| HTTP 方法不被支持                                |
| 502  | `opencli_error`     | opencli 子进程退出非零(详见内嵌 stderr)         |
| 500  | `internal`          | gateway 自身抛错                                 |
| 503  | `unavailable`       | 视频子系统未配置 / temp store 未配置            |

---

## 1. `GET /health`

无鉴权(供 LB / healthcheck 用)。

```bash
curl http://<host>:9378/health
# → 200 {"ok":true,"data":{"status":"up"}}
```

---

## 2. `GET /sites`

列出 manifest 中所有已注册站点(无 query 即全量;`?q=<substring>` 模糊过滤)。

```bash
curl -H "Authorization: Bearer $K" http://<host>:9378/sites
curl -H "Authorization: Bearer $K" "http://<host>:9378/sites?q=google"
# → 200 {"ok":true,"data":[{ "site":"...", "name":"...", "description":"...", "access":"...", "args":[...] }, ...]}
```

---

## 3. `GET /sites/:site/help`

列出指定站点的全部命令及其参数 schema。

```bash
curl -H "Authorization: Bearer $K" http://<host>:9378/sites/google/help
```

返回 `[{ site, name, description, access, args: [{name,type,positional,required,default,help}, ...] }, ...]`。

---

## 4. `POST /sites/:site/:command` ⭐ 新增

**Per-site 快捷端点** — 把 `POST /run` 解构成 RESTful 路径。Body 中的 `args` 完全透传给 opencli 的 manifest parameter binding;不做归一化、不自动补默认值(除 `<site> login` 自动注入 `--timeout 30` 与 `/run` 行为一致)。

- Path:
  - `site` —— manifest 注册名(例 `google`、`reddit`、`bilibili`、`hackernews`)
  - `command` —— 该 site 的 manifest 命令名(例 `google` 站点下有 `search` / `images` / `news` / `suggest` / `trends`)
- 不支持 passthrough site(`browser`、`doctor`),会 400 `bad_args` —— 这些仍走 `/run`。
- Body: `{ "args": { ... } }`(无 args 时可省,空对象即可)

### 4.1 例:Google web search

```bash
curl -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"args":{"keyword":"rust async runtime","limit":10,"lang":"en"}}' \
  http://<host>:9378/sites/google/search
```

参数 schema 来自 manifest 的 `google/search`:

| 字段      | 类型 | 必填 | 默认 | 透传给 opencli 形态 |
|-----------|------|------|------|----------------------|
| `keyword` | str  | ✅   | —    | 位置参数 1            |
| `limit`   | int  | ✗    | 10   | `--limit 10`          |
| `lang`    | str  | ✗    | en   | `--lang en`           |

成功响应(伪结构,实际字段以站点返 YAML→JSON 转换结果为准):

```json
{ "ok": true, "data": { "rows": [ { "type": "...", "title": "...", "url": "...", "snippet": "..." } ] } }
```

### 4.2 例:Hacker News top(无需参数)

```bash
curl -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{}' \
  http://<host>:9378/sites/hackernews/top
```

### 4.3 例:需要登录(Bilibili)

`http://<host>:9378/sites/bilibili/login` 触发站点登录。当子进程返回 `AUTH_REQUIRED`,gateway 把 VNC URL 一并返回:

```json
{
  "ok": true,
  "data": {
    "error": { "code": "AUTH_REQUIRED", "message": "...", "help": "Please log in to https://www.bilibili.com" },
    "vncUrl": "http://textvision.top:6080/vnc.html?autoconnect=true&...",
    "hint": "Open the VNC link, log in, then re-run."
  }
}
```

注:`AUTH_REQUIRED` 时 HTTP 仍为 200,业务错误挂在 `data.error.code`。

### 4.4 例:Passthrough site 拒绝

```bash
curl -X POST -H "Authorization: Bearer $K" -d '{}' http://<host>:9378/sites/browser/navigate
# → 400 {"ok":false,"error":{"code":"bad_args","message":"passthrough site \"browser\" is not callable via /sites/:site/:command; use /run instead"}}
```

---

## 5. `POST /run` — 通用入口

任意 site / command 都能从这里调。Body:

```json
{
  "site": "google",
  "command": "search",
  "args": {
    "keyword": "rust async runtime",
    "limit": 10,
    "lang": "en"
  }
}
```

`args` 内部约定:
- `passthrough site`(`browser`、`doctor`)用透传布局;`args._` 给 positionals,`args.session` 排到第一位置,其他键作为 `--key value` flags。
- manifest 站点直接走 `buildArgs`。

成功:`{ "ok": true, "data": <opencli---> }`。AUTH_REQUIRED 同 §4.3。错误见开头错误码表。

---

## 6. `POST /login`

无 site/command 概念,直接开 VNC 给浏览器手动登录。

```bash
curl -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"url":"https://www.bilibili.com"}' \
  http://<host>:9378/login
# → 200 {"ok":true,"data":{"vncUrl":"http://textvision.top:6080/vnc.html?autoconnect=true&..."}}
```

---

## 7. `POST /video/search`

统一跨平台视频搜索,**底层走 yt-dlp**,最多并发 3 个站;用平台码表替代每站单独的命令。

### Body

```json
{
  "query": "kimi K3",
  "platform": "all",          // 可选;默认 bilibili+youtube+tiktok
  "limit": 10                  // 可选;1..30,默认 10
}
```

`platform` 取值:
- 缺省 / `"all"` —— 全部 8 站:`bilibili`、`youtube`、`douyin`、`tiktok`、`instagram`、`xiaohongshu`、`weibo`、`twitter`(注意 `youtube`、`tiktok`、`twitter` 在裸 IP 网络下通常会被 GFW 拦,需 v2raya 代理或忽略 stats.failed)
- `"all"` —— 同上但显式全量
- `bilibili|youtube|douyin|tiktok|instagram|xiaohongshu|weibo|twitter` —— 单站

### 响应

```json
{
  "ok": true,
  "data": {
    "query": "kimi K3",
    "platform": null,    // 或 "all" / 单站名
    "results": [ { "site": "...", "title": "...", "url": "...", ... } ],
    "stats": { "succeeded": ["site1", "site2"], "failed": [{ "site": "...", "error": "..." }] }
  }
}
```

per-site 失败**不会**让整个请求 fail —— 失败者落到 `stats.failed`,成功者照常返回。

---

## 8. `POST /video/download`

单/批量视频下载(走 yt-dlp + Camofox 注入的登录 cookies)。

### Body

```json
{
  "urls": ["https://www.youtube.com/watch?v=...", "https://www.bilibili.com/video/..."],
  "quality": "720p"   // 可选; best|1080p|720p|480p|worst,默认 720p
}
```

约束:`urls` 长度 1..3,每项必须 `http(s)`。

### 响应

```json
{
  "ok": true,
  "data": {
    "results": [
      { "url": "https://...", "ok": true,  "filename": "video_<uuid>.mp4", "size_bytes": 12345678,
        "download_url": "http://<host>:9378/files/<uuid>.mp4",
        "method": "yt-dlp", "expires_in_seconds": 3600 },
      { "url": "https://...", "ok": false, "error_code": "LOGIN_REQUIRED",
        "message": "Camofox returned no cookies for bilibili.com" }
    ]
  }
}
```

成功项的 `download_url` 可用,带 1h TTL;`/files/...` 是公开 GET(无鉴权)见 §9。

---

## 9. `GET /files/:id`

下载已下载的视频/音频文件。**无需鉴权**(路径里携带不可猜 UUID)。

约束:仅 GET,1 小时 TTL,过期或已清理返回 404 `not_found`。

```bash
curl -OJ "http://<host>:9378/files/<uuid>.mp4"   # -OJ 用 Content-Disposition 里 filename
```

`Content-Type` 根据扩展名(`mp4`/`webm`/`mkv`/`m4a`/其他 → `application/octet-stream`)。
