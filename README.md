# Camofox · OpenCLI ☤

Camofox + OpenCLI — 163+ website adapters in the cloud. One Docker container combining [Camofox](https://github.com/jo-inc/camofox-browser) anti-detection browser + [Shim](https://github.com/Fectivnfy112357/camofox-shim) bridge layer.

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Built with Docker](https://img.shields.io/badge/Built%20with-Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![中文](https://img.shields.io/badge/Lang-中文-red?style=for-the-badge)](README.zh-CN.md)

## Cloud OpenCLI + VNC Remote Login

OpenCLI runs natively on your desktop — a Chrome browser on your laptop, a local daemon controlling it via Chrome Extension. It stops working the moment you close your laptop.

Camofox · OpenCLI moves it to the cloud:

```
Your computer            Cloud server
───────────              ─────────────
                           ┌──────────────────────────────┐
                           │   Docker container            │
                           │                              │
  opencli zhihu            │   OpenCLI Daemon             │
  search 'AI agent'  ─────▶   (:19825)                    │
                           │        │                     │
                           │        │ WebSocket           │
                           │        ▼                     │
                           │   Camofox Shim               │
                           │        │                     │
                           │        │ REST API            │
                           │        ▼                     │
                           │   Camofox Firefox browser    │
                           │   (:9377)                    │
                           │                              │
  Open noVNC link          │   VNC remote desktop (:6080) │
  in browser ─────────────▶  ← scan QR, cookies persist   │
                           │                              │
                           └──────────────────────────────┘
```

**Log in once, always online.** Open Zhihu/Xiaohongshu/Xianyu via noVNC, scan the QR code once, and the cookies are written to the Docker Volume. After that, every `opencli` command automatically carries the login session — even after container restarts or rebuilds.

**Zero changes to OpenCLI source.** All 163 adapters call `page.goto()`, `page.evaluate()`, and other browser APIs. The Shim impersonates a Chrome Extension, connects to the OpenCLI daemon's WebSocket, intercepts commands, translates them into Camofox REST API calls, and sends results back. OpenCLI has no idea the browser behind it is Firefox.

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│                        Docker container                           │
│                                                                  │
│  User runs: opencli zhihu search 'AI agent'                      │
│         │                                                        │
│         │ HTTP POST /command                                     │
│         ▼                                                        │
│  ┌──────────────────────────────────┐                            │
│  │  OpenCLI Daemon (:19825)         │  ← unmodified daemon       │
│  │  HTTP Server + WebSocket /ext    │                            │
│  └──────────┬───────────────────────┘                            │
│             │ WebSocket forwards commands                        │
│             ▼                                                    │
│  ┌──────────────────────────────────┐                            │
│  │  Camofox Shim (v2)               │  ← bridge layer            │
│  │  • Impersonates Chrome Extension │                            │
│  │  • Connects to daemon /ext WS    │                            │
│  │  • Translates commands → REST    │                            │
│  └──────────┬───────────────────────┘                            │
│             │ HTTP REST                                          │
│             ▼                                                    │
│  ┌──────────────────────────────────┐                            │
│  │  Camofox browser (:9377)         │  ← Firefox engine          │
│  │  • Anti-detection fingerprinting │                            │
│  │  • VNC remote desktop (:6080)    │                            │
│  │  • Cookie persistence            │                            │
│  └──────────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
```

### Command Translation: DaemonCommand → Camofox REST API

OpenCLI sends 14 `DaemonCommand` types over WebSocket. The Shim maps them to Camofox REST endpoints:

| OpenCLI Command | Purpose | → Camofox API | Status |
|----------------|------|---------------|:---:|
| `navigate` | Page navigation | `POST /tabs/:tabId/navigate` | ✅ |
| `exec` | JS evaluation | `POST /tabs/:tabId/evaluate` | ✅ |
| `screenshot` | Screenshot | `GET /tabs/:tabId/screenshot` | ✅ |
| `cookies` | Get cookies | `GET /sessions/:userId/cookies` | ✅ |
| `tabs` | Tab management | `POST/GET/DELETE /tabs` | ✅ |
| `insert-text` | Text input | `POST /tabs/:tabId/press` | ✅ |
| `bind` | Bind tab | Internal mapping | ✅ |
| `close-window` | Close window | `DELETE /sessions/:userId` | ✅ |
| `cdp` | Chrome DevTools | — | ❌ Firefox has no CDP |
| `set-file-input` | File upload | — | ❌ Not implemented |
| `network-capture-*` | Network capture | — | ❌ No Firefox equivalent |
| `wait-download` | Download wait | — | ❌ Not implemented |
| `frames` | Iframe list | — | ❌ Not implemented |

> 8/14 commands implemented, covering all core social platform adapter needs. Unimplemented CDP/network commands don't affect Bilibili, Zhihu, Xiaohongshu, Twitter, etc.

### A Complete Data Flow

```
1. User: opencli zhihu search 'AI agent'
2. CLI → HTTP POST /command → daemon(:19825)
3. Daemon → WebSocket /ext → Shim (impersonating Chrome Extension)
4. Shim parses: {action: "navigate", url: "https://www.zhihu.com/search?q=..."}
5. Shim → Camofox: POST /tabs/:tabId/navigate {userId, url}
6. Shim parses: {action: "exec", code: "wait for page load → scrape results"}
7. Shim → Camofox: POST /tabs/:tabId/evaluate {expression: code, timeout: 120000}
8. Camofox returns JSON → Shim → WebSocket → Daemon → CLI → user sees results
```

## Quick Deploy

```bash
git clone --recurse-submodules https://github.com/Fectivnfy112357/camofox-opencli.git
cd camofox-opencli
docker compose build --no-cache
docker compose up -d
```

## Usage

```bash
docker exec -it camofox bash

# No login required
opencli bilibili search 'gaming'
opencli v2ex hot

# Login required (see VNC login below)
opencli zhihu search 'AI agent'
opencli xiaohongshu search 'camping'

# List all 163 platforms
opencli list
```

## VNC Remote Login

For platforms requiring login (Zhihu, Xiaohongshu, Twitter, etc.), use noVNC to scan a QR code once — cookies persist automatically:

```bash
# Generate a VNC link and auto-navigate to the target site
python3 scripts/camofox-vnc-login.py fectivnfy --url https://www.zhihu.com

# Output: http://textvision.top:6080/vnc.html?autoconnect=true&resize=scale&token=xxxx
# Open in browser → scan QR → done
```

After logging in once, all `opencli` commands automatically reuse the session. Cookies are stored in a Docker Volume — they survive container restarts and rebuilds.

## Updating

```bash
cd camofox-opencli
git pull
git submodule update --remote
docker compose down && docker compose build --no-cache && docker compose up -d
```

## Subprojects

| Repository | Description | License |
|-----------|------|------|
| [camofox-browser](https://github.com/Fectivnfy112357/camofox-browser) | Camofox fork, added GET cookies endpoint | MIT |
| [camofox-shim](https://github.com/Fectivnfy112357/camofox-shim) | WebSocket bridge, OpenCLI ↔ Camofox | MIT |
| [OpenCLI](https://github.com/Fectivnfy112357/OpenCLI) | 163+ site adapters CLI tool | MIT |

## License

This project is licensed under the [MIT License](LICENSE).

Subproject licenses:
- **camofox-browser** — Based on [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser) (MIT), fork adds `GET /sessions/:userId/cookies` endpoint and `entrypoint-camofox.sh`.
- **camofox-shim** — Original project, MIT.
- **OpenCLI** — Based on [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI) (MIT), fork is unmodified, used as a submodule.

All three subprojects retain their upstream MIT licenses. This project is also MIT.

---

Built with ❤️