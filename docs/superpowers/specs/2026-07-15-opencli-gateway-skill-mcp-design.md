# 设计文档：opencli 对外暴露 — HTTP 网关 + Skill + MCP

日期：2026-07-15
状态：已批准设计，待写实施计划

## 1. 背景与目标

当前 `opencli` 命令只能在 camofox Docker 容器内执行，外部 agent 无法调用。目标是把 opencli 的全部能力对外暴露，形成标准的 **Skill** 和 **MCP**，让不同 agent（Claude Code、Cursor 等）零门槛对接。

约束与已知事实：
- opencli 有约 **1406 条命令 / 150+ 站点**（`opencli/cli-manifest.json`），不可能逐一枚举成工具。
- opencli 全局支持 `opencli <site> <command> [args] --format json` 输出结构化 JSON。
- opencli 还提供通用 `opencli browser <action>` 原语、`opencli doctor`。
- 登录态通过 Camofox `POST /sessions/:userId/toggle-display` 返回 noVNC 链接完成（参考 Hermes `browser-auth-recovery` skill 的 `camofox-vnc-login.py`）。
- 容器内已有：camofox(:9377) + opencli daemon(:19825) + shim，由 supervisord 管理。

## 2. 架构

```
外部 agent (Claude Code / Cursor / …)
   ├── skill: opencli-camofox   (python 脚本 → HTTP)
   └── MCP client               (streamable HTTP)
                    │  Authorization: Bearer <GATEWAY_API_KEY>
                    ▼
   ┌────────────────────────────────────────────────┐
   │ camofox 容器 (supervisord)                        │
   │                                                  │
   │  opencli-gateway :8080   ← 新增 (本仓 gateway/)    │
   │    • REST 端点                                    │
   │    • 内置 MCP (streamable HTTP, /mcp)             │
   │    • spawn `opencli … --format json`             │
   │    • 读 cli-manifest.json 做发现/help              │
   │    • login → camofox toggle-display → vncUrl      │
   │         │                                        │
   │  opencli daemon :19825 → shim → camofox :9377     │
   └────────────────────────────────────────────────┘
```

新增组件全部放在 **camofox 容器内**（supervisord 新增进程），对外映射 `:8080`。网关**单进程**同时提供 REST 和 MCP（内置 MCP，不再单开进程）。

## 3. 组件设计

### 3.1 网关 opencli-gateway（本仓新目录 `gateway/`）

- **技术栈**：Node.js 22 + TypeScript（与 shim / opencli 同生态）；MCP 用 `@modelcontextprotocol/sdk` 的 streamable HTTP transport。
- **鉴权**：环境变量 `GATEWAY_API_KEY`。所有端点（除 `/health`）要求 `Authorization: Bearer <key>`，缺失/错误返回 401。
- **执行方式**：收到请求后 spawn `opencli <site> <command> [args] --format json`，捕获 stdout 解析为 JSON 返回。命令白名单/参数由 cli-manifest.json 校验，避免注入。
- **发现数据源**：启动时加载 `/opt/opencli/cli-manifest.json`，构建 site → commands 索引。

#### REST 端点

| 方法 | 端点 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查（免鉴权） |
| GET | `/sites?q=` | 列举/搜索站点。`q` 省略时返回**全部**站点；带 `q` 时模糊匹配站点名/描述 |
| GET | `/sites/:site/help` | 该站点全部命令 + 参数 + columns（agent 查到站点后知道怎么调） |
| POST | `/run` | body `{site, command, args:{}, format?}`，执行任意 opencli 命令，返回结构化 JSON |
| POST | `/browser` | body `{action, ...}`，通用浏览器原语透传（navigate/click/type/snapshot/screenshot 等） |
| POST | `/login` | body `{site}` 或 `{url}`，触发登录并返回 `{vncUrl}`（移植 camofox-vnc-login 逻辑） |
| GET | `/doctor` | 诊断 |

`/login` 的 vncUrl 获取流程（移植参考脚本）：
1. `ensure_tabs`：确保该 userId 至少有一个 tab（VNC toggle 需要 tab 才返回 vncUrl）。
2. `POST /sessions/:userId/toggle-display {headless:"virtual"}` 取 `vncUrl`；无则 cycle `headless=false → "virtual"` 重试最多 3 次。
3. 用 `CAMOFOX_URL` 的 hostname 改写 vncUrl 中的 `localhost`。
4. 若带 `url`，新建 tab 并导航到目标页，再返回链接。

### 3.2 内置 MCP（网关 `/mcp` 端点，streamable HTTP）

**通用工具（渐进式披露）**：
- `list_sites(q?)` — q 省略=全部站点
- `site_help(site)` — 返回该站点命令清单与参数
- `run_command(site, command, args)` — 执行任意命令
- `browser(action, ...)` — 通用浏览器原语
- `login(site)` — 返回 noVNC 链接
- `doctor()`

**一级站点工具（10 个，各带内嵌 help 描述）**：
`xiaohongshu, bilibili, twitter, reddit, zhihu, douyin, weibo, youtube, hackernews, github`

每个是 `<site>_command(command, args)` 形式，工具 description 内嵌该站点命令清单（从 manifest 生成），省去 agent 先 `site_help` 的一步。其余 140+ 站点走 `list_sites → site_help → run_command` 渐进式披露，避免 1406 个工具塞爆 context。

### 3.3 Skill：opencli-camofox

- 结构：`SKILL.md` + `scripts/*.py`（仅用 Python stdlib `urllib`，无三方依赖）+ `references/`。
- 因为底层是通用 `/run`，skill 天然**覆盖全部 opencli 能力**。
- 脚本（都用 py 调 HTTP，不用 curl）：
  - `scripts/list_sites.py [q]`
  - `scripts/site_help.py <site>`
  - `scripts/run.py <site> <command> [--key value ...]`
  - `scripts/browser.py <action> [...]`
  - `scripts/vnc_login.py [<site>] [--url URL]`（移植参考脚本，改为调网关 `/login`）
- SKILL.md 教工作流：搜站点 → 看 help → run → 遇登录墙调 vnc_login → 把 VNC 链接给用户。
- 配置：`OPENCLI_GATEWAY_URL` + `GATEWAY_API_KEY`（env 或 `.env`）。

## 4. 部署

- **Dockerfile**：新增 stage 编译 `gateway/`（`npm ci && tsc`），产物复制到 `/opt/gateway/`。
- **supervisord.conf**：新增 `[program:gateway]`，priority 在 shim 之后，`command=node /opt/gateway/dist/index.js`。
- **docker-compose.yml**：`ports` 增加 `"8080:8080"`；`environment` 增加 `GATEWAY_API_KEY`。
- 网关需能读到 `/opt/opencli/cli-manifest.json` 和调用 `opencli`（PATH 已有软链 `/usr/local/bin/opencli`）。

## 5. 错误处理

- 鉴权失败 → 401。
- 未知 site/command（不在 manifest）→ 400，附可用列表提示。
- opencli spawn 非零退出 / stdout 非 JSON → 502，回传 stderr 摘要。
- `/login` 无法取得 vncUrl（多次重试后）→ 502。
- 所有响应统一 envelope：`{ok, data?, error?:{code,message}}`。

## 6. 测试

- 网关：单元测 manifest 加载 / 参数校验 / envelope；集成测 `/health`、`/sites`、`/sites/:site/help`（mock spawn）。
- MCP：工具 schema 生成、渐进式披露路径。
- skill：脚本对空/带参、鉴权头、错误码的处理（mock 网关）。
- 端到端：容器内 `opencli hackernews`（Tier1 免登录）验证 `/run`；一个需登录站点验证 `/login` 返回 vncUrl。

## 7. 关键决策

| # | 决策 | 原因 |
|---|---|---|
| G1 | 网关单进程内置 MCP，不单开进程 | 少一个进程，REST/MCP 共享 manifest 与 spawn 逻辑 |
| G2 | 渐进式披露 + 10 站点一级工具 | 1406 命令无法全塞 MCP；常用站点直达，长尾按需展开 |
| G3 | `/sites` 无 q 返回全部 | 用户明确要求 |
| G4 | skill 用 Python stdlib 调 HTTP，不用 curl | 用户明确要求；无三方依赖易分发 |
| G5 | 网关放本仓 `gateway/` | 用户选定；省事，随 camofox-shim 一起构建 |
| G6 | API key 鉴权 | 网关对外映射公网需保护 |
| G7 | login 移植 camofox-vnc-login.py 逻辑到网关 | 复用已验证的 toggle-display 流程 |

## 8. 参考

- Hermes skill `browser-auth-recovery`（VNC 链接获取流程）
- `DESIGN.md`（shim v2 架构）
- `opencli/cli-manifest.json`（命令清单，发现数据源）
