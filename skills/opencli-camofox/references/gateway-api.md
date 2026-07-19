# Gateway API Reference

Base: `$OPENCLI_GATEWAY_URL` (default `http://localhost:8080`)
Auth: `Authorization: Bearer $GATEWAY_API_KEY` on all endpoints except `/health`.
Envelope: `{ok: bool, data?: any, error?: {code, message}}`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, data:{status:"up"}}` |
| GET | `/sites?q=` | — | `data: [{site, commands}]` (q omitted = all) |
| GET | `/sites/:site/help` | — | `data: [{site,name,description,access,args[]}]` |
| POST | `/run` | `{site, command, args:{}}` | `data`: adapter JSON output |
| POST | `/login` | `{url?}` | `data:{vncUrl}` |
| POST/GET | `/mcp` | MCP protocol | streamable HTTP MCP endpoint |

## /run args

- For manifest adapter commands, `args` keys match the arg names shown by
  `/sites/:site/help`. Positionals may be passed by name or via `args._` (array).
- For passthrough sites `browser` and `doctor` (not in the manifest), args are
  raw: `args._` (array) → leading positionals; other keys → `--key value`
  (boolean `true` → bare `--key`).

## MCP tools
- Generic: `list_sites(q?)`, `site_help(site)`, `run_command(site,command,args)`,
  `browser(action,args)`, `login(url?)`, `doctor()`
- Primary-site direct tools (embed their command list in the description):
  `xiaohongshu_command, bilibili_command, twitter_command, reddit_command,
  zhihu_command, douyin_command, weibo_command, youtube_command,
  hackernews_command, github_command` — each takes `{command, args}`.
- Other ~160 sites: use `list_sites` → `site_help` → `run_command`.
