# Camofox Shim — 设计文档 v2

## 1. 项目概述

Camofox Shim 是 OpenCLI 和 Camofox 浏览器之间的桥接层。它作为 **WebSocket 客户端** 连接到 OpenCLI 的 daemon，伪装成 Chrome Extension，截获来自 OpenCLI 的命令，翻译成 Camofox REST API 调用，然后将结果返回。

**核心价值**：让 OpenCLI 的 100+ 平台适配器（小红书、X/Twitter、Reddit 等）零改动地运行在 Camofox 浏览器上，复用 Camofox 的反爬指纹、VNC 登录和 Cookie 持久化能力。

## 2. 架构（v2 WebSocket 客户端模式）

```
┌──────────────────────────────────────────────────────────────────┐
│                    Docker 容器                                    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ OpenCLI daemon (:19825)                                  │    │
│  │ HTTP Server + WebSocket /ext                             │    │
│  │                                                          │    │
│  │ CLI → HTTP POST /command → daemon → WS /ext → Shim      │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                              │ WebSocket 客户端连接               │
│  ┌──────────────────────────▼──────────────────────────────┐    │
│  │ Camofox Shim (Node.js)                                  │    │
│  │ • 连接到 daemon 的 /ext WebSocket                        │    │
│  │ • 伪装成 Chrome Extension                                │    │
│  │ • 翻译 DaemonCommand → Camofox REST API                  │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                              │ HTTP REST                         │
│  ┌──────────────────────────▼──────────────────────────────┐    │
│  │ Camofox 浏览器 (:9377)                                   │    │
│  │ • 反爬指纹 Firefox                                        │    │
│  │ • VNC 登录 (:6080)                                       │    │
│  │ • GET /sessions/:userId/cookies (含 HttpOnly)            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ OpenCLI CLI (forked, 零改动)                             │    │
│  │ opencli bilibili search "恐怖黎明"                       │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

**关键变化（v1 → v2）**：
- v1：Shim 作为 HTTP 服务器监听 19825，与 OpenCLI daemon 抢端口 ❌
- v2：Shim 作为 WebSocket 客户端连接 daemon，不监听任何端口 ✅

## 3. 数据流

```
1. CLI 发送命令: HTTP POST /command → daemon(:19825)
2. Daemon 转发: WebSocket /ext → Shim
3. Shim 翻译: Camofox REST API → HTTP 请求
4. Shim 返回: WebSocket → Daemon → HTTP 响应 → CLI
```

## 4. 协议分析

### 4.1 OpenCLI Daemon WebSocket 协议

Chrome Extension 通过 WebSocket 连接 daemon 的 `/ext` 端点：

| 消息类型 | 方向 | 内容 |
|---------|------|------|
| `hello` | Extension → Daemon | `{type: "hello", version, contextId, compatRange}` |
| `ping` | Extension ↔ Daemon | 心跳保持连接 |
| `log` | Daemon → Extension | `{type: "log", level, msg}` |
| 命令结果 | Extension → Daemon | `{id, ok, data}` |
| 命令转发 | Daemon → Extension | 完整 `DaemonCommand` JSON |

### 4.2 DaemonCommand 类型

| Action | 用途 | 参数字段 | Shim 支持 |
|--------|------|---------|:---:|
| `exec` | JS 执行 | `code`, `page`, `frameIndex` | ✅ |
| `navigate` | 导航 | `url` | ✅ |
| `tabs` | 标签页管理 | `op` (list/new/close/select) | ✅ |
| `cookies` | 获取 Cookie | `domain`, `url` | ✅ |
| `screenshot` | 截图 | `format`, `quality`, `fullPage` | ✅ |
| `close-window` | 关闭窗口 | — | ✅ |
| `insert-text` | 文本插入 | `text` | ✅ |
| `bind` | 绑定标签页 | — | ✅ |
| `lease-release` | 释放租约 | `runId` | ✅ |
| `set-file-input` | 文件上传 | `files`, `selector` | ❌ |
| `cdp` | CDP 原始命令 | `cdpMethod`, `cdpParams` | ❌ |
| `network-capture-*` | 网络捕获 | — | ❌ |
| `wait-download` | 下载等待 | `pattern`, `timeoutMs` | ❌ |
| `frames` | iframe 列表 | — | ❌ |

### 4.3 Camofox REST API（含自定义 GET cookies 端点）

| 端点 | 方法 | 用途 | 对应 OpenCLI Action |
|------|------|------|-------------------|
| `/tabs` | POST | 创建标签页 | `tabs(op:new)` |
| `/tabs` | GET | 列出标签页 | `tabs(op:list)` |
| `/tabs/:tabId/navigate` | POST | 导航 | `navigate` |
| `/tabs/:tabId/snapshot` | GET | 可访问性快照 | — |
| `/tabs/:tabId/click` | POST | 点击元素 | — |
| `/tabs/:tabId/type` | POST | 输入文本 | — |
| `/tabs/:tabId/press` | POST | 按键 | — |
| `/tabs/:tabId/scroll` | POST | 滚动 | — |
| `/tabs/:tabId/screenshot` | GET | 截图（base64） | `screenshot` |
| `/tabs/:tabId/evaluate` | POST | JS 执行 | `exec` |
| `DELETE /tabs/:tabId` | DELETE | 关闭标签页 | `tabs(op:close)` |
| `/sessions/:userId/cookies` | POST | 设置 Cookie | — |
| `/sessions/:userId/cookies` | GET | **获取 Cookie（含 HttpOnly）** | `cookies` |
| `DELETE /sessions/:userId` | DELETE | 删除会话 | `close-window` |
| `/health` | GET | 健康检查 | — |

> **注意**：`GET /sessions/:userId/cookies` 是我们向 Camofox fork 新增的端点（约 20 行代码），用于获取包括 HttpOnly 在内的全部 Cookie。

## 5. Shim 实现

### 5.1 技术选型

- **运行时**：Node.js 22（与 Camofox 同生态，Docker 内一致）
- **WebSocket 客户端**：ws 库
- **HTTP 客户端**：Node.js 内置 fetch（v18+）
- **无 Express**：v2 不再需要 HTTP 服务器

### 5.2 文件结构

```
camofox-shim/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # 入口：WebSocket 客户端
│   ├── translator.ts     # 命令翻译引擎
│   ├── session.ts        # 会话管理
│   ├── camofox-client.ts # Camofox REST API 客户端
│   └── types.ts          # 类型定义
├── Dockerfile            # 多阶段构建
└── README.md
```

### 5.3 命令处理流程（v2）

```
1. Shim 连接到 daemon 的 WebSocket /ext 端点
2. 发送 hello 消息伪装成 Chrome Extension
3. 接收 daemon 转发的 DaemonCommand
4. 查找或创建 session → (userId, tabId)
5. 翻译 action → Camofox REST API 调用
6. 返回结果 via WebSocket
```

## 6. Docker 部署

### 6.1 统一镜像

`Dockerfile`（位于项目根目录 `D:\programming\projects\my project\Dockerfile`）：

```
Stage 1: 编译 OpenCLI (npm ci → npm run build) → /opt/opencli/
Stage 2: 编译 Shim (npm ci → npx tsc) → /opt/shim/
Stage 3: 基于 camofox-browser 镜像
  → 安装 supervisor
  → 入口脚本 → dist/src/server.js (commonjs 编译产物)
  → 复制 opencli + shim
  → supervisord 管理多进程
```

### 6.2 supervisord 进程管理

```ini
[program:camofox]       # Camofox 浏览器 :9377 + VNC :6080
[program:opencli-daemon] # OpenCLI daemon :19825
[program:shim]          # Shim WebSocket 客户端（连接 daemon）
```

### 6.3 docker-compose.yml

```yaml
services:
  camofox:
    build: { context: . }
    ports: [9377:9377, 6080:6080, 19825:19825]
    environment:
      CAMOFOX_API_KEY: "..."
      VNC_PASSWORD: "..."
```

### 6.4 服务器部署

```
/www/dk_project/dk_app/camofox-stack/   ← 服务器端路径
```

## 7. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CAMOFOX_URL` | `http://localhost:9377` | Camofox REST API 地址 |
| `CAMOFOX_API_KEY` | — | Camofox API 密钥 |
| `OPENCLI_DAEMON_WS` | `ws://127.0.0.1:19825/ext` | OpenCLI daemon WebSocket 地址 |
| `CAMOFOX_USER_ID` | `default` | Camofox 用户 ID |

## 8. Hermes 本地配置

`~/.hermes/.env` 中的 Camofox 配置：

```
CAMOFOX_URL=http://textvision.top:9377
CAMOFOX_API_KEY=my_secret_api_key_123
CAMOFOX_USER_ID=fectivnfy
```

## 9. 当前状态

| 组件 | 状态 | 备注 |
|------|------|------|
| Camofox 浏览器 | ✅ | `GET /sessions/:userId/cookies` 端点已添加到 fork |
| OpenCLI daemon | ✅ | supervisord 自动启动 |
| Shim (WebSocket 客户端) | ✅ | 成功连接 daemon |
| Shim 会话自愈 | ✅ | "Tab not found" 时自动重建 tab + 重 navigate 到 lastUrl |
| Shim `network-capture-*` | ✅ | 返回成功(空数据)而非 unsupported,让 opencli browser open 走通 |
| Gateway REST + MCP | ✅ | 16 工具全部正常,20 并发不触发熔断 |
| Gateway 日志 | ✅ | JSONL 写到宿主 `logs/gateway/gateway.log` |
| 服务器一键部署 | ✅ | `camofox-opencli/deploy.sh` |
| `opencli bilibili search` | ✅ | 验证 20 条结果 |
| Hermes 浏览器能力 | ✅ | navigate/click/type/scroll/screenshot/cookies 全部正常 |
| VNC 登录 | ✅ | toggle-display API 生成 noVNC 链接 |

### 已知问题

1. **Camofox fork 的 `dist/src/` 未编译**：基础镜像 `ghcr.io/redf0x1/camofox-browser:latest` 的 `server.js` 是 ESM 源码但 `package.json` 声明 commonjs，需要通过 `dist/src/server.js` 运行
2. **Camofox 每小时被 IDLE_TIMEOUT 回收**：tabId 失效,需 Shim 会话自愈(已实现)

## 10. 关键决策记录

| # | 决策 | 原因 |
|---|------|------|
| D1 | Shim 作为 WebSocket 客户端而非 HTTP 服务器 | 避免与 OpenCLI daemon 抢端口 19825 |
| D2 | 使用 Camofox fork 而非 patch 基础镜像 | 最小改动,20 行 GET cookies 端点 |
| D3 | `dist/src/server.js` 作为 Camofox 入口 | 基础镜像的 `server.js` 是 ESM 无法在 commonjs 包内运行 |
| D4 | supervisord 管理多进程 | 同一容器内运行 Camofox + daemon + Shim + Gateway |
| D5 | 不支持 CDP 命令 | Camofox 是 Firefox 内核,社交平台适配器不依赖 CDP |
| D6 | Cookie 用 evaluate fallback | GET cookies 端点不可用时用 `document.cookie`(不含 HttpOnly) |
| D7 | Shim 会话自愈(Tab not found → 重建) | VNC 手动登录 / IDLE_TIMEOUT 让 tabId 失效,需自动从 lastUrl 恢复 |
| D8 | Shim 把 `network-capture-*` 视为"成功+空数据" | opencli browser open/click 在 goto 前主动调 startNetworkCapture,Camofox REST 无 Network domain,但 opencli CLI 没暴露跳过开关 → 让它"成功"才能继续往下走 |

## 11. Gateway 层(opencli 对外暴露)

在 v2 shim 之上新增 `gateway/`(Node/TS,容器内 `:8080`),把 opencli 全部能力对外暴露给任意 agent。单进程同时提供 REST + 内置 MCP(streamable HTTP `/mcp`)。

```
外部 agent ──(REST / MCP, Bearer)── gateway :8080
   │  spawn `opencli <site> <command> --format json`
   ▼
opencli daemon :19825 → shim → camofox :9377
```

REST：`/health`、`/sites?q=`(无 q=全部)、`/sites/:site/help`、`/run`、`/login`(→vncUrl)。
MCP：通用 `list_sites/site_help/run_command/browser/login/doctor` + 10 一级站点工具(`PRIMARY_SITES`),其余 ~160 站点走渐进式披露。
skill `skills/opencli-camofox/`：Python stdlib 调 gateway HTTP。

### 11.1 MCP 并发修复

**根因**:无状态 `StreamableHTTPServerTransport` 不能复用单例。SDK 内部按 JSON-RPC request id 维护流映射,共享 transport 时并发请求响应流串台 → 部分请求失败 → 3 次失败触发 Claude Code 熔断(~37-60s cooldown)。

**修复**:`/mcp` 每请求新建 `McpServer` + `StreamableHTTPServerTransport`,`res.on('close')` 清理;host 用每请求 `ctx.clientHost`(替代全局可变变量)。

### 11.2 日志落文件

`gateway/src/logger.ts` 写 JSONL 到 `GATEWAY_LOG_DIR/gateway.log`(默认 `/var/log/gateway`)+ stdout 镜像。写失败降级不抛,避开"supervisord /dev/stdout 失败"的历史坑。容器内日志目录由 `entrypoint.sh`(root) `chown` 给 node(因宿主 bind-mount 是 root-owned),然后 exec supervisord。宿主路径由 `docker-compose.yml` 的 `${GATEWAY_LOG_HOST_DIR:-./logs/gateway}` 配置。

### 11.3 login 默认 timeout

`<site> login` 命令 opencli 默认 300s,在 MCP 客户端里会"卡住"。Gateway 层在用户未传 `args.timeout` 时自动注入 `--timeout 30`,用户传值则覆盖。同步在 REST `/run`。

### 11.4 browser.positional 容错

Claude Code MCP 工具 UI 无法填顶层数组字段,值退到 `args.positional`。Gateway handler 自动从 `args.positional` 提取到 argv positionals。同时 `positional` schema 接受 `null`/record/array 三种形态。

### 11.5 决策记录(Gateway)

| # | 决策 | 原因 |
|---|------|------|
| G1 | 网关单进程内置 MCP | REST/MCP 共享 manifest 与 spawn 逻辑 |
| G2 | 渐进式披露 + 10 一级站点工具 | 1277 命令无法全塞 MCP |
| G3 | `/sites` 无 q 返回全部 | 用户要求 |
| G4 | skill 用 Python stdlib,不用 curl | 用户要求,无三方依赖 |
| G5 | 网关放本仓 `gateway/` | 随 camofox-shim 一起构建 |
| G6 | API key 鉴权 | 公网暴露保护 |
| G7 | browser/doctor 走 passthrough | 不在 manifest,raw 拼参数 |
| G8 | MCP 每请求新建 transport | 修复 JSON-RPC 流串台导致的熔断 |
| G9 | 日志双写(file + stdout) | 既能 host 排查又不依赖 docker logs |
| G10 | login 默认 timeout 30s | 避免 MCP UI 长时间卡住 |
| G11 | args.positional 自动提升 | 适配 Claude Code UI 数组字段限制 |

## 12. 服务器部署

### 12.1 deploy.sh

主仓库根 `camofox-opencli/deploy.sh` 一键部署:
```
git pull → sync submodule → docker compose build → up -d
       → 健康检查 → 8 并发 /health 探活 → tail 日志(可选)
```

支持 `--no-build`(源码未变秒级重启)、`--logs`(部署完跟踪日志)。

### 12.2 路径与端口

```
服务器: /www/dk_project/dk_app/camofox-opencli/
宿主日志: ./logs/gateway/{gateway.log, supervisor-stdout.log, supervisor-stderr.log}
宿主页:  GATEWAY_LOG_HOST_DIR env (默认 ./logs/gateway)

暴露端口:
  9377  Camofox REST
  6080  noVNC
  19825 opencli daemon(WS/HTTP)
  8080  gateway REST + MCP(/mcp)
```

### 12.3 GitHub submodule 自动更新

`bump-submodules.yml` 每日 cron(03:17 UTC)+ 子仓库 `notify-aggregate.yml` repository_dispatch 触发,自动 bump 主仓库的子模块指针到最新 HEAD,无需手动改 `.gitmodules`。submodule 同步加 `--force`(历史 commit 曾跟踪 node_modules,残留文件导致 checkout 冲突)。

## 13. 参考
- [OpenCLI fork](https://github.com/Fectivnfy112357/OpenCLI) — 100+ 平台适配器
- [Camofox fork](https://github.com/Fectivnfy112357/camofox-browser) — 含 GET cookies 端点
- [Camofox Shim](https://github.com/Fectivnfy112357/camofox-shim) — WebSocket 客户端桥接
- [Camofox OpenCLI](https://github.com/Fectivnfy112357/camofox-opencli) — 部署聚合仓库(deploy.sh/supervisord/docker-compose)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — 浏览器工具后端
- [agent-reach](https://github.com/Panniantong/Agent-Reach) — 社交媒体数据源