# Camofox Stack ☤

将 [OpenCLI](https://github.com/jackwener/OpenCLI) 的 163+ 站点适配器从 Chrome 浏览器迁移到 [Camofox](https://github.com/jo-inc/camofox-browser) 反检测浏览器，加上 [Shim](https://github.com/Fectivnfy112357/camofox-shim) 桥接层，一键 Docker 部署。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Built with Docker](https://img.shields.io/badge/Built%20with-Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![中文](https://img.shields.io/badge/Lang-中文-red?style=for-the-badge)](README.md)

**让 163+ 个网站变成你的 CLI 命令行工具。** 基于 OpenCLI 的站点适配器生态，通过 Camofox 反检测浏览器运行，支持 VNC 手动登录、Cookie 持久化、以及完整的数据抓取能力。一个 Docker 容器装下全部。

## 为什么要把 OpenCLI 从 Chrome 换到 Camofox？

OpenCLI 原生架构依赖 Chrome 浏览器：CLI 命令 → HTTP POST → 本地 daemon → WebSocket → Chrome Extension → CDP 协议控制 Chrome。这套方案在桌面环境很好用，但有几个限制：

| 问题 | Chrome 原生方案 | Camofox 方案 |
|------|----------------|-------------|
| **运行环境** | 需要图形桌面，无法在无头服务器运行 | Docker 容器内运行，无需图形桌面 |
| **反检测** | Chrome 指纹明显，容易被反爬识别 | Firefox 内核 + 指纹伪装，绕过反爬 |
| **登录态** | 登录态绑定本地 Chrome Profile | Cookie 持久化在 Docker Volume，容器重建不丢失 |
| **远程运维** | 必须远程桌面或 VNC 到服务器 | 内置 noVNC，浏览器打开链接即可操作 |
| **多实例** | 一个 Chrome 实例一套 Profile | 多 userId 隔离，多租户共享一台服务器 |

**核心思路：不改 OpenCLI 一行代码。** OpenCLI 有 163 个站点适配器，每个适配器都调用 `page.goto()`、`page.evaluate()` 等浏览器 API。如果直接修改 OpenCLI 源码来支持 Camofox，需要改动所有适配器，维护成本极高。

于是我们写了 **Camofox Shim**——一个 200 行的桥接层，它伪装成 Chrome Extension 连接到 OpenCLI 的 daemon，截获所有浏览器命令，翻译成 Camofox 的 REST API 调用，然后原路返回结果。OpenCLI 完全不知道背后的浏览器已经换成了 Firefox。

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
│  │  Camofox Shim (v2)               │  ← 200 行桥接层            │
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

### 命令翻译：OpenCLI DaemonCommand → Camofox REST API

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

> 8/14 命令已实现，覆盖所有社交平台适配器的核心需求。未实现的 CDP/网络捕获等命令不影响小红书、知乎、B站、Twitter 等平台的使用。

### 一次完整的数据流

```
1. 用户: opencli zhihu search 'AI agent'
2. CLI → HTTP POST /command → daemon(:19825)
3. Daemon → WebSocket /ext → Shim（伪装成 Chrome Extension）
4. Shim 解析命令: {action: "navigate", url: "https://www.zhihu.com/search?q=..."}
5. Shim → Camofox REST: POST /tabs/:tabId/navigate {userId, url}
6. Shim 解析命令: {action: "exec", code: "等待页面加载 → 抓取搜索结果"}
7. Shim → Camofox REST: POST /tabs/:tabId/evaluate {expression: code, timeout: 120000}
8. Camofox 返回 JSON 结果 → Shim → WebSocket → Daemon → CLI → 用户看到结果
```

## 平台矩阵

| 平台 | 命令 | 需要登录 | 验证状态 |
|------|------|:---:|:---:|
| **B站** | `opencli bilibili search '关键词'` | ❌ | ✅ |
| **知乎** | `opencli zhihu search '关键词'` | ✅ | ✅ |
| **小红书** | `opencli xiaohongshu search '关键词'` | ✅ | 待验证 |
| **Twitter/X** | `opencli twitter search '关键词'` | ✅ | 待验证 |
| **微博** | `opencli weibo hot` | ✅ | 待验证 |
| **Reddit** | `opencli reddit search '关键词'` | ✅ | 待验证 |
| **V2EX** | `opencli v2ex hot` | ❌ | 待验证 |
| **GitHub** | `opencli github search '关键词'` | ❌ | 待验证 |
| **YouTube** | `opencli youtube search '关键词'` | ❌ | 待验证 |
| **闲鱼** | `opencli xianyu search '关键词'` | ✅ | ⚠️ Firefox 兼容性 |

> 完整列表：`opencli list` — 163 个站点适配器，覆盖社交媒体、电商、开发、视频、播客等领域。

## 快速部署

```bash
# 克隆仓库（含子模块）
git clone --recurse-submodules https://github.com/Fectivnfy112357/camofox-stack.git
cd camofox-stack

# 构建并启动
docker compose build --no-cache
docker compose up -d
```

## 使用

```bash
# 进入容器
docker exec -it camofox bash

# 搜索 B站
opencli bilibili search '关键词'

# 搜索知乎（需先登录）
opencli zhihu search 'AI agent'

# 搜索小红书
opencli xiaohongshu search '露营装备'

# 查看所有可用平台
opencli list
```

## 登录态管理

部分平台需要登录才能使用。通过 VNC 手动登录，Cookie 自动持久化：

```bash
# 生成 VNC 链接并导航到目标网站
python3 scripts/camofox-vnc-login.py fectivnfy --url https://www.zhihu.com

# 输出 VNC 链接，浏览器打开后扫码登录
# Cookie 保存在 /home/node/.camofox/profiles/fectivnfy/
```

登录一次后，后续所有 `opencli` 命令自动复用登录态。容器重启、重建都不丢失（Docker Volume 持久化）。

## 更新

```bash
cd camofox-stack
git pull
git submodule update --remote
docker compose down && docker compose build --no-cache && docker compose up -d
```

## 子项目

| 仓库 | 说明 | 许可 |
|------|------|------|
| [camofox-browser](https://github.com/Fectivnfy112357/camofox-browser) | Camofox fork，新增 GET cookies 端点 | MIT |
| [camofox-shim](https://github.com/Fectivnfy112357/camofox-shim) | WebSocket 桥接层，连接 OpenCLI ↔ Camofox | MIT |
| [OpenCLI](https://github.com/Fectivnfy112357/OpenCLI) | 163+ 站点适配器 CLI 工具 | MIT |

## 开源协议

本项目（camofox-stack）采用 [MIT License](LICENSE)。

子项目许可：
- **camofox-browser** — 基于 [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser)（MIT），fork 新增了 `GET /sessions/:userId/cookies` 端点和 `entrypoint-camofox.sh` 启动脚本。
- **camofox-shim** — 原创项目，MIT License。
- **OpenCLI** — 基于 [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)（MIT），fork 未修改源码，仅作为子模块引用。

三个子项目均保持上游 MIT 协议，本项目亦以 MIT 协议发布。

---

Built with ❤️