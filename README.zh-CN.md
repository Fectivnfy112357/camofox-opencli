# Camofox · OpenCLI ☤

![架构图](assets/architecture.png)

Camofox + OpenCLI — 将 163+ 站点适配器搬上云端，通过 [Camofox](https://github.com/jo-inc/camofox-browser) 反检测浏览器 + [Shim](https://github.com/Fectivnfy112357/camofox-shim) 桥接层，一个 Docker 容器全搞定。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Built with Docker](https://img.shields.io/badge/Built%20with-Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![English](https://img.shields.io/badge/Lang-English-blue?style=for-the-badge)](README.md)

## 云端 OpenCLI + VNC 远程登录

OpenCLI 原生跑在桌面端——你的笔记本上开个 Chrome 浏览器，本地 daemon 通过 Chrome Extension 控制它。这套方案离开你的电脑就动不了。

Camofox · OpenCLI 把它搬上云端：

```
你的电脑                云端服务器
─────────              ─────────────
                         ┌──────────────────────────────┐
                         │   Docker 容器                 │
                         │                              │
  opencli zhihu          │   OpenCLI Daemon             │
  search 'AI agent'  ───▶   (:19825)                    │
                         │        │                     │
                         │        │ WebSocket           │
                         │        ▼                     │
                         │   Camofox Shim               │
                         │        │                     │
                         │        │ REST API            │
                         │        ▼                     │
                         │   Camofox Firefox 浏览器      │
                         │   (:9377)                    │
                         │                              │
  浏览器打开              │   VNC 远程桌面 (:6080)       │
  noVNC 链接 ──────────▶  │   ← 扫码登录，Cookie 持久化  │
                         │                              │
                         └──────────────────────────────┘
```

**登录一次，永远在线。** 通过 noVNC 远程打开知乎/小红书/闲鱼，扫码登录后 Cookie 写入 Docker Volume。之后无论容器重启还是重建，所有 `opencli` 命令自动携带登录态。

**不改一行 OpenCLI 源码。** 163 个适配器都调用 `page.goto()`、`page.evaluate()` 等浏览器 API。Shim 伪装成 Chrome Extension 连接到 OpenCLI daemon 的 WebSocket，截获命令翻译成 Camofox REST API，再原路返回结果。OpenCLI 完全不知道背后的浏览器是 Firefox。

## 它如何工作

```
┌──────────────────────────────────────────────────────────────────┐
│                         Docker 容器                               │
│                                                                  │
│  用户执行 opencli zhihu search 'AI agent'                        │
│         │                                                        │
│         │ HTTP POST /command                                     │
│         ▼                                                        │
│  ┌──────────────────────────────────┐                            │
│  │  OpenCLI Daemon (:19825)         │  ← 原版 daemon，未修改     │
│  │  HTTP Server + WebSocket /ext    │                            │
│  └──────────┬───────────────────────┘                            │
│             │ WebSocket 转发命令                                  │
│             ▼                                                    │
│  ┌──────────────────────────────────┐                            │
│  │  Camofox Shim (v2)               │  ← 桥接层                  │
│  │  • 伪装成 Chrome Extension       │                            │
│  │  • 连接 daemon 的 /ext WebSocket │                            │
│  │  • 翻译 DaemonCommand → REST API │                            │
│  └──────────┬───────────────────────┘                            │
│             │ HTTP REST                                          │
│             ▼                                                    │
│  ┌──────────────────────────────────┐                            │
│  │  Camofox 浏览器 (:9377)          │  ← Firefox 内核            │
│  │  • 反检测指纹伪装                │                            │
│  │  • VNC 远程桌面 (:6080)          │                            │
│  │  • Cookie 持久化                 │                            │
│  └──────────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
```

### 命令翻译：DaemonCommand → Camofox REST API

OpenCLI 通过 WebSocket 发送 14 种 `DaemonCommand`，Shim 将它们映射到 Camofox 的 REST 端点：

| OpenCLI 命令 | 用途 | → Camofox API | 状态 |
|-------------|------|---------------|:---:|
| `navigate` | 页面导航 | `POST /tabs/:tabId/navigate` | ✅ |
| `exec` | JS 执行 | `POST /tabs/:tabId/evaluate` | ✅ |
| `screenshot` | 截图 | `GET /tabs/:tabId/screenshot` | ✅ |
| `cookies` | 获取 Cookie | `GET /sessions/:userId/cookies` | ✅ |
| `tabs` | 标签页管理 | `POST/GET/DELETE /tabs` | ✅ |
| `insert-text` | 文本输入 | `POST /tabs/:tabId/press` | ✅ |
| `bind` | 绑定标签页 | 内部映射，无需 API | ✅ |
| `close-window` | 关闭窗口 | `DELETE /sessions/:userId` | ✅ |
| `cdp` | Chrome DevTools | — | ❌ Firefox 无 CDP |
| `set-file-input` | 文件上传 | — | ❌ 未实现 |
| `network-capture-*` | 网络捕获 | — | ❌ Firefox 无等效 |
| `wait-download` | 下载等待 | — | ❌ 未实现 |
| `frames` | iframe 列表 | — | ❌ 未实现 |

> 8/14 命令已实现，覆盖所有社交平台适配器的核心需求。CDP 等未实现命令不影响 B站、知乎、小红书、Twitter 等平台的使用。

### 一次完整的数据流

```
1. 用户: opencli zhihu search 'AI agent'
2. CLI → HTTP POST /command → daemon(:19825)
3. Daemon → WebSocket /ext → Shim（伪装成 Chrome Extension）
4. Shim 解析: {action: "navigate", url: "https://www.zhihu.com/search?q=..."}
5. Shim → Camofox: POST /tabs/:tabId/navigate {userId, url}
6. Shim 解析: {action: "exec", code: "等待页面加载 → 抓取搜索结果"}
7. Shim → Camofox: POST /tabs/:tabId/evaluate {expression: code, timeout: 120000}
8. Camofox 返回 JSON → Shim → WebSocket → Daemon → CLI → 用户看到结果
```

## MCP + Skill：给外部 Agent 用

容器内还跑了一个 **opencli gateway**（`:8080`），把 163+ 平台适配器通过两种方式暴露给外部 Agent，并附带一个开箱即用的 Claude skill：

| 传输 | 端点 | 鉴权 |
|---|---|---|
| REST | `GET/POST /health`, `/sites`, `/sites/:site/help`, `/run`, `/login` | `Authorization: Bearer $GATEWAY_API_KEY` |
| MCP | `POST /mcp`（streamable HTTP） | 同上的 Bearer 令牌 |

### MCP 工具

- **通用**：`list_sites`、`site_help`、`run_command`、`browser`、`login`、`doctor`
- **每个站点**（10 个主平台，每个工具的 description 里内嵌命令清单）：`xiaohongshu_command`、`bilibili_command`、`twitter_command`、`reddit_command`、`zhihu_command`、`douyin_command`、`weibo_command`、`youtube_command`、`hackernews_command`、`github_command`
- 其他约 160 个站点通过 `run_command` + `site_help` 调用

### 接入 MCP 客户端

Claude Desktop（`claude_desktop_config.json`）或 Claude Code（`.mcp.json`）：

```json
{
  "mcpServers": {
    "camofox-opencli": {
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer YOUR_GATEWAY_API_KEY" }
    }
  }
}
```

`login` 工具会返回 noVNC 链接 —— 浏览器打开后扫码登录，Cookie 自动持久化。

### 开箱即用的 Claude skill

`skills/opencli-camofox/` 已随容器发布 —— 纯标准库 Python 脚本，通过 HTTP 调用 gateway。设置 `OPENCLI_GATEWAY_URL` + `GATEWAY_API_KEY`（或写到 `~/.opencli-gateway.env`），Claude Agent 就能直接用 `list_sites`、`site_help`、`run`、`browser`、`vnc_login`，零额外配置。

### Gateway 环境变量

| 变量 | 默认值 |
|---|---|
| `GATEWAY_PORT` | `8080` |
| `GATEWAY_API_KEY` | _（REST + MCP 鉴权必填）_ |
| `OPENCLI_BIN` | `opencli` |
| `OPENCLI_MANIFEST` | `/opt/opencli/cli-manifest.json` |

## 快速部署

```bash
git clone --recurse-submodules https://github.com/Fectivnfy112357/camofox-opencli.git
cd camofox-opencli
docker compose build --no-cache
docker compose up -d
```

## 使用

```bash
docker exec -it camofox bash

# 无需登录即可使用
opencli bilibili search '恐怖黎明'
opencli v2ex hot

# 需先登录（见下方 VNC 登录）
opencli zhihu search 'AI agent'
opencli xiaohongshu search '露营装备'

# 查看全部 163 个平台
opencli list
```

## VNC 远程登录

需要登录的平台（知乎、小红书、Twitter 等），通过 noVNC 远程扫码登录，Cookie 自动持久化：

```bash
# 生成 VNC 链接并自动导航到目标网站
python3 scripts/camofox-vnc-login.py fectivnfy --url https://www.zhihu.com

# 输出: http://textvision.top:6080/vnc.html?autoconnect=true&resize=scale&token=xxxx
# 浏览器打开 → 扫码登录 → 完成
```

登录一次后，所有 `opencli` 命令自动复用登录态。Cookie 保存在 Docker Volume，容器重启、重建都不丢失。

## 更新

```bash
cd camofox-opencli
git pull
git submodule update --init --remote
docker compose down && docker compose build --no-cache && docker compose up -d
```

> **子模块自动保持最新。** 每个子仓库（`camofox-browser`、`camofox-shim`、`OpenCLI`）默认分支每次推送都会通过 `.github/workflows/notify-aggregate.yml` 通知本聚合仓库。本仓库的 `.github/workflows/bump-submodules.yml` 会自动开一个 PR，把子模块指针 bump 到上游最新 HEAD。每天 UTC 03:17 还有一次兜底 cron 任务，防止 webhook 漏触发。
>
> 维护者提示：bump PR 通过 CI 后会自动合入 `main`（或者手动 merge）。本仓库只需要 **一个 Secret**：
> - `AGGREGATE_PUSH_TOKEN` —— 一个对 `camofox-opencli` 有 `contents: write` + `pull-requests: write` 权限的 PAT，bump workflow 用它推送 bump 分支。
> - `AGGREGATE_DISPATCH_TOKEN` —— 在每个子仓库配置，只需对 `camofox-opencli` 有 `contents: read` 权限，用来发 `repository_dispatch`。

## 子项目

| 仓库 | 说明 | 许可 |
|------|------|------|
| [camofox-browser](https://github.com/Fectivnfy112357/camofox-browser) | Camofox fork，新增 GET cookies 端点 | MIT |
| [camofox-shim](https://github.com/Fectivnfy112357/camofox-shim) | WebSocket 桥接层，连接 OpenCLI ↔ Camofox | MIT |
| [OpenCLI](https://github.com/Fectivnfy112357/OpenCLI) | 163+ 站点适配器 CLI 工具 | MIT |

## 开源协议

本项目采用 [MIT License](LICENSE)。

子项目许可：
- **camofox-browser** — 基于 [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser)（MIT），fork 新增 `GET /sessions/:userId/cookies` 端点和 `entrypoint-camofox.sh`。
- **camofox-shim** — 原创项目，MIT。
- **OpenCLI** — 基于 [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)（MIT），fork 未修改源码，仅作为子模块引用。

三个子项目均保持上游 MIT 协议，本项目亦以 MIT 协议发布。

---

Built with ❤️