# Camofox Stack ☤

[OpenCLI](https://github.com/jackwener/OpenCLI) 163+ 平台适配器 + [Camofox](https://github.com/jo-inc/camofox-browser) 反检测浏览器 + [Shim](https://github.com/Fectivnfy112357/camofox-shim) 桥接层，一键 Docker 部署。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Built with Docker](https://img.shields.io/badge/Built%20with-Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![中文](https://img.shields.io/badge/Lang-中文-red?style=for-the-badge)](README.md)

**让 163+ 个网站变成你的 CLI 命令行工具。** 基于 OpenCLI 的站点适配器生态，通过 Camofox 反检测浏览器运行，支持 VNC 手动登录、Cookie 持久化、以及完整的数据抓取能力。一个 Docker 容器装下全部。

## 它能做什么

| 平台 | 能力 | 示例 |
|------|------|------|
| **B站** | 搜索视频 | `opencli bilibili search '恐怖黎明'` |
| **知乎** | 搜索文章/回答 | `opencli zhihu search 'AI agent'` |
| **小红书** | 搜索笔记 | `opencli xiaohongshu search '露营装备'` |
| **Twitter/X** | 搜索推文 | `opencli twitter search 'AI news'` |
| **闲鱼** | 搜索商品 | `opencli xianyu search iphone` |
| **微博** | 热搜/搜索 | `opencli weibo hot` |
| **Reddit** | 搜索帖子 | `opencli reddit search 'python'` |
| **GitHub** | 搜索仓库 | `opencli github search 'ai agent'` |
| **YouTube** | 搜索视频 | `opencli youtube search 'tutorial'` |
| **V2EX** | 热门帖子 | `opencli v2ex hot` |

> 完整列表：`opencli list` — 163 个站点适配器，覆盖社交媒体、电商、开发、视频、播客等领域。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                    Docker 容器                            │
│                                                          │
│  opencli bilibili search → OpenCLI Daemon (:19825)       │
│         │                          │                     │
│         │ HTTP POST /command       │ WebSocket /ext      │
│         ▼                          ▼                     │
│    ┌─────────┐              ┌──────────────┐             │
│    │  CLI    │              │  Camofox     │             │
│    │ 入口    │              │  Shim (v2)   │             │
│    └─────────┘              └──────┬───────┘             │
│                                    │ REST API            │
│                                    ▼                     │
│                           ┌────────────────┐             │
│                           │  Camofox       │             │
│                           │  Firefox 浏览器 │             │
│                           │  (:9377)       │             │
│                           │  VNC (:6080)   │             │
│                           └────────────────┘             │
└──────────────────────────────────────────────────────────┘
```

- **OpenCLI** — 163+ 站点适配器，统一的 CLI 命令接口
- **Camofox Shim** — WebSocket 客户端桥接，将 OpenCLI 命令翻译为 Camofox REST API
- **Camofox** — 基于 Firefox 的反检测浏览器，支持 VNC 远程登录和 Cookie 持久化

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

# 搜索知乎
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

登录一次后，后续所有 `opencli` 命令自动复用登录态。容器重启、重建都不丢失（volume 持久化）。

## 更新

```bash
cd camofox-stack
git pull
git submodule update --remote
docker compose down && docker compose build --no-cache && docker compose up -d
```

## 子项目

| 仓库 | 说明 |
|------|------|
| [camofox-browser](https://github.com/Fectivnfy112357/camofox-browser) | Camofox fork，新增 GET cookies 端点 |
| [camofox-shim](https://github.com/Fectivnfy112357/camofox-shim) | WebSocket 桥接层，连接 OpenCLI ↔ Camofox |
| [OpenCLI](https://github.com/Fectivnfy112357/OpenCLI) | 163+ 站点适配器 CLI 工具 |

## License

MIT — Built with ❤️