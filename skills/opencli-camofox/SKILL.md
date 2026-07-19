---
name: opencli-camofox
description: >
  Use when an agent needs to fetch data from or interact with 170+ websites
  (xiaohongshu/小红书, bilibili/B站, twitter/X, reddit, zhihu/知乎, douyin/抖音,
  weibo/微博, youtube, hackernews, github, and many more) through the Camofox
  anti-detection browser via the opencli gateway. Covers search, read, post,
  and generic browser automation. Also handles manual login (noVNC link) when
  a site requires authentication.
  Triggers: opencli, camofox, 小红书搜索, B站, 爬取, browser automation on a
  logged-in site, "get posts from", "search <platform>".
version: 1.0.0
---

# opencli-camofox

Bridge to the opencli gateway (`:8080`) which runs 170+ platform adapters on
the Camofox browser. All scripts are stdlib-only Python calling the gateway
over HTTP.

## Setup

Set env (or write `~/.opencli-gateway.env`):
```
OPENCLI_GATEWAY_URL=http://<host>:8080
GATEWAY_API_KEY=<key>
```

## Workflow

1. **Discover a site**: `python scripts/list_sites.py [query]`
   - No query → all sites. Query → fuzzy match.
2. **Learn its commands**: `python scripts/site_help.py <site>`
   - Shows each command's args (name / type / required / positional).
3. **Run a command**: `python scripts/run.py <site> <command> [--key value | --flag]`
   - Example: `python scripts/run.py bilibili search --keyword 恐怖黎明 --limit 5`
   - Bare non-`--` tokens are sent as positionals; the gateway orders them per manifest.
4. **Generic browser control** (any page): `python scripts/browser.py <action> [...]`
   - Actions: navigate, click, type, scroll, snapshot, screenshot, get, etc.
   - Example: `python scripts/browser.py navigate https://example.com`
5. **Login wall / CAPTCHA / Cloudflare**: `python scripts/vnc_login.py [--url URL]`
   - Prints a noVNC URL. **Share it with the user** to log in manually.
   - Do NOT ask the user for passwords/OTP in chat. Do NOT try to solve CAPTCHAs.
   - After the user confirms login, re-run the original command; cookies persist.

## Notes

- Every response is a JSON envelope `{ok, data?, error?}`.
- On `unknown_command`, run `site_help.py` first.
- On auth errors (401), check `GATEWAY_API_KEY`.
- See `references/gateway-api.md` for the full endpoint reference.
