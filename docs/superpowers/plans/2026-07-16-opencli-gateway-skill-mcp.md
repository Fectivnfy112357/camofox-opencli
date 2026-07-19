# OpenCLI Gateway + Skill + MCP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 camofox 容器内新增一个 Node/TS 网关(`:8080`),把 opencli 全部能力通过 REST + 内置 MCP 对外暴露,并提供一个 Python skill 让任意 agent 对接。

**Architecture:** 网关单进程同时提供 REST 端点和 streamable-HTTP MCP;收到请求后 spawn `opencli <site> <command> --format json` 并解析 stdout;发现能力读 `cli-manifest.json`;登录走 Camofox `toggle-display` 返回 noVNC 链接。skill 用 Python stdlib(urllib)调网关 HTTP,零三方依赖。

**Tech Stack:** Node.js 22 + TypeScript、`@modelcontextprotocol/sdk`(streamable HTTP)、Node 内置 `node:http` / `child_process`、Python 3 stdlib、supervisord、Docker 多阶段构建、vitest(网关测试)。

## Global Constraints

- 网关运行时 Node.js 22;与 shim/opencli 同生态。
- 鉴权:环境变量 `GATEWAY_API_KEY`;除 `GET /health` 外所有端点要求 `Authorization: Bearer <key>`,缺失/错误返回 401。
- 所有 REST 响应统一 envelope:`{ok:boolean, data?:unknown, error?:{code:string,message:string}}`。
- 网关通过 spawn `opencli <site> <command> [args] --format json` 执行;命令/参数用 manifest 校验,防注入。
- 发现数据源:`/opt/opencli/cli-manifest.json`(容器内),本地开发用 `../opencli/cli-manifest.json`。manifest 为数组,记录字段含 `site,name,description,access,args[]`,`args[]` 元素含 `name,type,required,positional,help`。
- 一级站点(10 个,MCP 一级工具):`xiaohongshu, bilibili, twitter, reddit, zhihu, douyin, weibo, youtube, hackernews, github`(均已确认存在于 manifest)。
- `GET /sites` 不传 `q` 返回全部站点。
- skill 脚本只用 Python stdlib(`urllib`),不用 curl,不引第三方包。
- 单文件尽量聚焦;网关代码放本仓 `gateway/` 目录。
- 网关默认监听 `0.0.0.0:8080`(`GATEWAY_PORT` 可覆盖);opencli 可执行路径由 `OPENCLI_BIN`(默认 `opencli`)、manifest 路径由 `OPENCLI_MANIFEST`(默认 `/opt/opencli/cli-manifest.json`)控制。

---

## 文件结构

网关(`gateway/`):
- `gateway/package.json` — 依赖与脚本
- `gateway/tsconfig.json` — TS 编译配置
- `gateway/src/config.ts` — 读环境变量(端口、api key、opencli bin、manifest 路径、camofox url/key)
- `gateway/src/manifest.ts` — 加载 manifest,提供 `listSites/searchSites/getSiteHelp/validateCommand`
- `gateway/src/opencli.ts` — spawn opencli,拼参数(区分 positional/flag),解析 JSON
- `gateway/src/camofox-login.ts` — toggle-display 取 vncUrl(移植参考脚本逻辑)
- `gateway/src/rest.ts` — REST 路由 + 鉴权中间件 + envelope
- `gateway/src/mcp.ts` — MCP server(通用工具 + 10 一级站点工具)
- `gateway/src/index.ts` — 启动 http server,挂载 rest + mcp(`/mcp`)
- `gateway/src/*.test.ts` — vitest 测试

skill(`skills/opencli-camofox/`):
- `skills/opencli-camofox/SKILL.md`
- `skills/opencli-camofox/scripts/_client.py` — 公共 HTTP 客户端(读 env/.env、加鉴权头)
- `skills/opencli-camofox/scripts/list_sites.py`
- `skills/opencli-camofox/scripts/site_help.py`
- `skills/opencli-camofox/scripts/run.py`
- `skills/opencli-camofox/scripts/browser.py`
- `skills/opencli-camofox/scripts/vnc_login.py`
- `skills/opencli-camofox/references/gateway-api.md`

部署:
- `Dockerfile` — 新增 stage 编译 gateway,复制到 `/opt/gateway/`
- `supervisord.conf` — 新增 `[program:gateway]`
- `docker-compose.yml` — 暴露 `8080:8080` + `GATEWAY_API_KEY`

---

### Task 1: 网关项目脚手架 + config

**Files:**
- Create: `gateway/package.json`
- Create: `gateway/tsconfig.json`
- Create: `gateway/src/config.ts`
- Create: `gateway/vitest.config.ts`
- Test: `gateway/src/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`,其中
  `interface Config { port: number; apiKey: string | null; opencliBin: string; manifestPath: string; camofoxUrl: string; camofoxApiKey: string | null; camofoxUserId: string }`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "opencli-gateway",
  "version": "0.1.0",
  "description": "HTTP + MCP gateway exposing opencli commands",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: 写 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 4: 写失败测试 config.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.apiKey).toBeNull();
    expect(c.opencliBin).toBe('opencli');
    expect(c.manifestPath).toBe('/opt/opencli/cli-manifest.json');
    expect(c.camofoxUserId).toBe('default');
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      GATEWAY_PORT: '9090',
      GATEWAY_API_KEY: 'secret',
      OPENCLI_BIN: '/usr/local/bin/opencli',
      CAMOFOX_USER_ID: 'fectivnfy',
    });
    expect(c.port).toBe(9090);
    expect(c.apiKey).toBe('secret');
    expect(c.opencliBin).toBe('/usr/local/bin/opencli');
    expect(c.camofoxUserId).toBe('fectivnfy');
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `cd gateway && npm install && npx vitest run src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`

- [ ] **Step 6: 实现 config.ts**

```ts
export interface Config {
  port: number;
  apiKey: string | null;
  opencliBin: string;
  manifestPath: string;
  camofoxUrl: string;
  camofoxApiKey: string | null;
  camofoxUserId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: Number(env.GATEWAY_PORT) || 8080,
    apiKey: env.GATEWAY_API_KEY?.trim() || null,
    opencliBin: env.OPENCLI_BIN?.trim() || 'opencli',
    manifestPath: env.OPENCLI_MANIFEST?.trim() || '/opt/opencli/cli-manifest.json',
    camofoxUrl: (env.CAMOFOX_URL?.trim() || 'http://localhost:9377').replace(/\/$/, ''),
    camofoxApiKey: env.CAMOFOX_API_KEY?.trim() || null,
    camofoxUserId: env.CAMOFOX_USER_ID?.trim() || 'default',
  };
}
```

- [ ] **Step 7: 运行确认通过**

Run: `cd gateway && npx vitest run src/config.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: 提交**

```bash
git add gateway/package.json gateway/tsconfig.json gateway/vitest.config.ts gateway/src/config.ts gateway/src/config.test.ts
git commit -m "feat(gateway): scaffold + config loader"
```

---

### Task 2: manifest 加载与站点发现

**Files:**
- Create: `gateway/src/manifest.ts`
- Test: `gateway/src/manifest.test.ts`
- Create (测试夹具): `gateway/src/__fixtures__/manifest.sample.json`

**Interfaces:**
- Consumes: `Config.manifestPath`(Task 1)
- Produces:
  - `interface CmdArg { name: string; type: string; required: boolean; positional: boolean; help?: string }`
  - `interface CmdRecord { site: string; name: string; description: string; access?: string; args: CmdArg[] }`
  - `class Manifest { constructor(records: CmdRecord[]); listSites(): string[]; searchSites(q?: string): {site:string; commands:number}[]; getSiteHelp(site: string): CmdRecord[]; findCommand(site: string, command: string): CmdRecord | undefined }`
  - `function loadManifest(path: string): Manifest`(读文件 → JSON.parse → 归一 args 默认值 → new Manifest)

- [ ] **Step 1: 写测试夹具 manifest.sample.json**

```json
[
  { "site": "bilibili", "name": "search", "description": "搜索B站视频",
    "access": "read",
    "args": [{ "name": "keyword", "type": "str", "required": true, "positional": true, "help": "关键词" },
             { "name": "limit", "type": "int", "required": false, "help": "数量" }] },
  { "site": "bilibili", "name": "comment", "description": "发评论", "access": "write", "args": [] },
  { "site": "hackernews", "name": "top", "description": "热门", "access": "read", "args": [] }
]
```

- [ ] **Step 2: 写失败测试 manifest.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadManifest } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '__fixtures__', 'manifest.sample.json');

describe('Manifest', () => {
  const m = loadManifest(fixture);

  it('lists unique sites', () => {
    expect(m.listSites().sort()).toEqual(['bilibili', 'hackernews']);
  });

  it('searchSites without q returns all with command counts', () => {
    const all = m.searchSites();
    expect(all.find((s) => s.site === 'bilibili')?.commands).toBe(2);
    expect(all.length).toBe(2);
  });

  it('searchSites with q filters by substring', () => {
    expect(m.searchSites('bili').map((s) => s.site)).toEqual(['bilibili']);
  });

  it('getSiteHelp returns commands for a site', () => {
    const help = m.getSiteHelp('bilibili');
    expect(help.map((c) => c.name).sort()).toEqual(['comment', 'search']);
  });

  it('findCommand returns matching record with normalized args', () => {
    const c = m.findCommand('bilibili', 'search');
    expect(c?.args[0]).toMatchObject({ name: 'keyword', positional: true, required: true });
    expect(c?.args[1]).toMatchObject({ name: 'limit', positional: false, required: false });
  });

  it('findCommand returns undefined for unknown', () => {
    expect(m.findCommand('bilibili', 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd gateway && npx vitest run src/manifest.test.ts`
Expected: FAIL — `Cannot find module './manifest.js'`

- [ ] **Step 4: 实现 manifest.ts**

```ts
import { readFileSync } from 'node:fs';

export interface CmdArg {
  name: string;
  type: string;
  required: boolean;
  positional: boolean;
  help?: string;
}

export interface CmdRecord {
  site: string;
  name: string;
  description: string;
  access?: string;
  args: CmdArg[];
}

export class Manifest {
  constructor(private records: CmdRecord[]) {}

  listSites(): string[] {
    return [...new Set(this.records.map((r) => r.site))];
  }

  searchSites(q?: string): { site: string; commands: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      if (q && !r.site.toLowerCase().includes(q.toLowerCase())) continue;
      counts.set(r.site, (counts.get(r.site) ?? 0) + 1);
    }
    return [...counts.entries()].map(([site, commands]) => ({ site, commands }));
  }

  getSiteHelp(site: string): CmdRecord[] {
    return this.records.filter((r) => r.site === site);
  }

  findCommand(site: string, command: string): CmdRecord | undefined {
    return this.records.find((r) => r.site === site && r.name === command);
  }
}

export function loadManifest(path: string): Manifest {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as any[];
  const records: CmdRecord[] = raw.map((r) => ({
    site: String(r.site),
    name: String(r.name),
    description: String(r.description ?? ''),
    access: r.access,
    args: Array.isArray(r.args)
      ? r.args.map((a: any) => ({
          name: String(a.name),
          type: String(a.type ?? 'str'),
          required: Boolean(a.required),
          positional: Boolean(a.positional),
          help: a.help ? String(a.help) : undefined,
        }))
      : [],
  }));
  return new Manifest(records);
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd gateway && npx vitest run src/manifest.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: 提交**

```bash
git add gateway/src/manifest.ts gateway/src/manifest.test.ts gateway/src/__fixtures__/manifest.sample.json
git commit -m "feat(gateway): manifest loader + site discovery"
```

---

### Task 3: opencli 执行器(拼参数 + spawn + 解析)

**Files:**
- Create: `gateway/src/opencli.ts`
- Test: `gateway/src/opencli.test.ts`

**Interfaces:**
- Consumes: `Manifest.findCommand`(Task 2)、`Config.opencliBin`(Task 1)
- Produces:
  - `function buildArgs(record: CmdRecord, args: Record<string, unknown>): string[]` — 按 manifest 顺序拼 CLI 参数:positional 参数按声明顺序取值放前面;非 positional 变成 `--name value`(boolean 为 true 时只放 `--name`,false 省略);末尾追加 `--format json`。缺 required 抛 `Error('missing required arg: <name>')`。
  - `interface RunResult { ok: boolean; data?: unknown; stderr?: string }`
  - `async function runOpencli(bin: string, site: string, command: string, argv: string[]): Promise<RunResult>` — spawn `bin site command ...argv`,收集 stdout/stderr,退出码 0 且 stdout 可 JSON.parse → `{ok:true,data}`;否则 `{ok:false,stderr}`。
  - `function execFactory(spawnImpl)` 便于测试注入。给出可注入的实现见下。

- [ ] **Step 1: 写失败测试 opencli.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { buildArgs, parseResult } from './opencli.js';
import type { CmdRecord } from './manifest.js';

const search: CmdRecord = {
  site: 'bilibili', name: 'search', description: '', access: 'read',
  args: [
    { name: 'keyword', type: 'str', required: true, positional: true },
    { name: 'limit', type: 'int', required: false, positional: false },
    { name: 'verbose', type: 'boolean', required: false, positional: false },
  ],
};

describe('buildArgs', () => {
  it('orders positionals first, then flags, then --format json', () => {
    expect(buildArgs(search, { keyword: '恐怖黎明', limit: 5 }))
      .toEqual(['恐怖黎明', '--limit', '5', '--format', 'json']);
  });

  it('boolean true becomes bare flag, false omitted', () => {
    expect(buildArgs(search, { keyword: 'x', verbose: true }))
      .toEqual(['x', '--verbose', '--format', 'json']);
    expect(buildArgs(search, { keyword: 'x', verbose: false }))
      .toEqual(['x', '--format', 'json']);
  });

  it('throws on missing required', () => {
    expect(() => buildArgs(search, { limit: 3 })).toThrow('missing required arg: keyword');
  });
});

describe('parseResult', () => {
  it('parses JSON stdout on exit 0', () => {
    expect(parseResult(0, '{"rows":[1,2]}', '')).toEqual({ ok: true, data: { rows: [1, 2] } });
  });
  it('returns stderr on nonzero exit', () => {
    expect(parseResult(1, '', 'boom')).toEqual({ ok: false, stderr: 'boom' });
  });
  it('returns error when stdout not JSON', () => {
    const r = parseResult(0, 'not json', '');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('non-JSON');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd gateway && npx vitest run src/opencli.test.ts`
Expected: FAIL — `Cannot find module './opencli.js'`

- [ ] **Step 3: 实现 opencli.ts**

```ts
import { spawn } from 'node:child_process';
import type { CmdRecord } from './manifest.js';

export interface RunResult {
  ok: boolean;
  data?: unknown;
  stderr?: string;
}

export function buildArgs(record: CmdRecord, args: Record<string, unknown>): string[] {
  const positionals = record.args.filter((a) => a.positional);
  const flags = record.args.filter((a) => !a.positional);
  const out: string[] = [];

  for (const a of positionals) {
    if (args[a.name] === undefined || args[a.name] === null) {
      if (a.required) throw new Error(`missing required arg: ${a.name}`);
      continue;
    }
    out.push(String(args[a.name]));
  }
  for (const a of flags) {
    const v = args[a.name];
    if (v === undefined || v === null) {
      if (a.required) throw new Error(`missing required arg: ${a.name}`);
      continue;
    }
    if (a.type === 'boolean') {
      if (v === true) out.push(`--${a.name}`);
    } else {
      out.push(`--${a.name}`, String(v));
    }
  }
  // ensure any required positional not iterated (already handled above)
  out.push('--format', 'json');
  return out;
}

export function parseResult(code: number, stdout: string, stderr: string): RunResult {
  if (code !== 0) return { ok: false, stderr: stderr || `exit ${code}` };
  try {
    return { ok: true, data: JSON.parse(stdout) };
  } catch {
    return { ok: false, stderr: `non-JSON stdout: ${stdout.slice(0, 300)}` };
  }
}

export function runOpencli(
  bin: string,
  site: string,
  command: string,
  argv: string[],
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [site, command, ...argv], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ ok: false, stderr: e.message }));
    child.on('close', (code) => resolve(parseResult(code ?? 1, stdout, stderr)));
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd gateway && npx vitest run src/opencli.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/opencli.ts gateway/src/opencli.test.ts
git commit -m "feat(gateway): opencli arg builder + spawn executor"
```

---

### Task 4: Camofox 登录(toggle-display → vncUrl)

**Files:**
- Create: `gateway/src/camofox-login.ts`
- Test: `gateway/src/camofox-login.test.ts`

**Interfaces:**
- Consumes: `Config`(camofoxUrl/camofoxApiKey/camofoxUserId, Task 1)
- Produces:
  - `function rewriteVncHost(vncUrl: string, camofoxUrl: string): string` — 用 camofoxUrl 的 hostname 替换 vncUrl 里的 host,保留 scheme/port/path/query。
  - `async function getVncUrl(cfg: Config, opts: { url?: string }, fetchImpl?: typeof fetch): Promise<string>` — 复刻参考脚本:ensureTabs → toggle `virtual` 取 vncUrl;无则 cycle `false`→`virtual` 重试最多 3 次;若 `opts.url` 则新建 tab 并 navigate;返回改写后的 vncUrl。取不到抛 `Error('could not obtain vncUrl')`。

- [ ] **Step 1: 写失败测试 camofox-login.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest';
import { rewriteVncHost, getVncUrl } from './camofox-login.js';
import type { Config } from './config.js';

const cfg: Config = {
  port: 8080, apiKey: null, opencliBin: 'opencli', manifestPath: '/x',
  camofoxUrl: 'http://textvision.top:9377', camofoxApiKey: 'k', camofoxUserId: 'u',
};

describe('rewriteVncHost', () => {
  it('replaces localhost with remote host, keeps port+path+query', () => {
    expect(rewriteVncHost('http://localhost:6080/vnc.html?token=abc', cfg.camofoxUrl))
      .toBe('http://textvision.top:6080/vnc.html?token=abc');
  });
});

describe('getVncUrl', () => {
  it('ensures tab then returns rewritten vncUrl from first toggle', async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/vnc.html?t=1' });
      return json({});
    });
    const out = await getVncUrl(cfg, {}, fake as any);
    expect(out).toBe('http://textvision.top:6080/vnc.html?t=1');
    expect(calls.some((c) => c.includes('/tabs?'))).toBe(true);
  });

  it('creates a tab when none exist', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([]);
      if (url.endsWith('/tabs')) return json({ tabId: 'new' });
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/x' });
      return json({});
    });
    const out = await getVncUrl(cfg, {}, fake as any);
    expect(out).toContain('textvision.top');
  });
});

function json(body: unknown) {
  return { ok: true, json: async () => body } as any;
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd gateway && npx vitest run src/camofox-login.test.ts`
Expected: FAIL — `Cannot find module './camofox-login.js'`

- [ ] **Step 3: 实现 camofox-login.ts**

```ts
import type { Config } from './config.js';

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.camofoxApiKey) h.Authorization = `Bearer ${cfg.camofoxApiKey}`;
  return h;
}

export function rewriteVncHost(vncUrl: string, camofoxUrl: string): string {
  const host = new URL(camofoxUrl).hostname;
  const v = new URL(vncUrl);
  v.hostname = host;
  return v.toString();
}

async function ensureTab(cfg: Config, f: typeof fetch): Promise<void> {
  try {
    const res = await f(`${cfg.camofoxUrl}/tabs?userId=${encodeURIComponent(cfg.camofoxUserId)}`,
      { headers: headers(cfg) });
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.tabs ?? [];
    if (list.length > 0) return;
  } catch { /* proceed */ }
  await f(`${cfg.camofoxUrl}/tabs`, {
    method: 'POST', headers: headers(cfg),
    body: JSON.stringify({ userId: cfg.camofoxUserId, sessionKey: `vnc_login_${cfg.camofoxUserId}` }),
  });
}

async function toggle(cfg: Config, f: typeof fetch, headless: 'virtual' | false): Promise<string> {
  const res = await f(`${cfg.camofoxUrl}/sessions/${cfg.camofoxUserId}/toggle-display`, {
    method: 'POST', headers: headers(cfg), body: JSON.stringify({ headless }),
  });
  const body = await res.json().catch(() => ({}));
  return body.vncUrl ?? '';
}

export async function getVncUrl(
  cfg: Config,
  opts: { url?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  await ensureTab(cfg, fetchImpl);
  let vnc = await toggle(cfg, fetchImpl, 'virtual');
  if (!vnc) {
    await toggle(cfg, fetchImpl, false).catch(() => '');
    for (let i = 0; i < 3 && !vnc; i++) vnc = await toggle(cfg, fetchImpl, 'virtual').catch(() => '');
  }
  if (!vnc) throw new Error('could not obtain vncUrl');

  if (opts.url) {
    const res = await fetchImpl(`${cfg.camofoxUrl}/tabs`, {
      method: 'POST', headers: headers(cfg),
      body: JSON.stringify({ userId: cfg.camofoxUserId, sessionKey: `vnc_nav_${cfg.camofoxUserId}` }),
    });
    const tab = await res.json();
    const tabId = tab.tabId ?? tab.id;
    if (tabId) {
      await fetchImpl(`${cfg.camofoxUrl}/tabs/${tabId}/navigate`, {
        method: 'POST', headers: headers(cfg),
        body: JSON.stringify({ userId: cfg.camofoxUserId, url: opts.url }),
      });
    }
  }
  return rewriteVncHost(vnc, cfg.camofoxUrl);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd gateway && npx vitest run src/camofox-login.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/camofox-login.ts gateway/src/camofox-login.test.ts
git commit -m "feat(gateway): camofox toggle-display vnc login"
```

---

### Task 5: REST 层(鉴权 + 路由 + envelope)

**Files:**
- Create: `gateway/src/rest.ts`
- Test: `gateway/src/rest.test.ts`

**Interfaces:**
- Consumes: `Manifest`(Task 2)、`buildArgs`/`runOpencli`(Task 3)、`getVncUrl`(Task 4)、`Config`(Task 1)
- Produces:
  - `interface Deps { cfg: Config; manifest: Manifest; run: (site:string,command:string,argv:string[])=>Promise<RunResult>; vnc: (opts:{url?:string})=>Promise<string> }`
  - `function createRestHandler(deps: Deps): (req: IncomingMessage, res: ServerResponse) => Promise<void>` — 处理下列路由,自动加鉴权(除 `GET /health`)。响应统一 envelope。
- 路由:`GET /health`、`GET /sites?q=`、`GET /sites/:site/help`、`POST /run`、`POST /login`。(`POST /browser` 在 Task 3 的 runOpencli 之上通过 `run('browser', action, argv)` 复用;此处 `/run` 已足够覆盖,`/browser` 作为 `/run` 的 `{site:'browser'}` 特例,不单独实现路由。)

- [ ] **Step 1: 写失败测试 rest.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createRestHandler } from './rest.js';
import { loadManifest } from './manifest.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadManifest(join(here, '__fixtures__', 'manifest.sample.json'));
const cfg: Config = { port: 8080, apiKey: 'secret', opencliBin: 'opencli', manifestPath: '/x',
  camofoxUrl: 'http://h:9377', camofoxApiKey: null, camofoxUserId: 'u' };

function mockRes() {
  return { statusCode: 0, body: '', headers: {} as Record<string,string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    writeHead(c: number) { this.statusCode = c; },
    end(b?: string) { this.body = b ?? ''; } };
}
function mockReq(method: string, url: string, auth?: string, body?: unknown) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return { method, url, headers: auth ? { authorization: auth } : {},
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } } as any;
}

const deps = { cfg, manifest,
  run: vi.fn(async () => ({ ok: true, data: { rows: [1] } })),
  vnc: vi.fn(async () => 'http://h:6080/vnc') };

describe('createRestHandler', () => {
  const h = createRestHandler(deps as any);

  it('GET /health needs no auth', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/health'), res as any);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('401 without bearer', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/sites'), res as any);
    expect(res.statusCode).toBe(401);
  });

  it('GET /sites returns all sites with valid key', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/sites', 'Bearer secret'), res as any);
    expect(res.statusCode).toBe(200);
    const env = JSON.parse(res.body);
    expect(env.ok).toBe(true);
    expect(env.data.length).toBe(2);
  });

  it('GET /sites/:site/help returns commands', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/sites/bilibili/help', 'Bearer secret'), res as any);
    expect(JSON.parse(res.body).data.map((c: any) => c.name).sort()).toEqual(['comment', 'search']);
  });

  it('POST /run executes and returns data', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/run', 'Bearer secret',
      { site: 'bilibili', command: 'search', args: { keyword: 'x' } }), res as any);
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: { rows: [1] } });
  });

  it('POST /run 400 on unknown command', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/run', 'Bearer secret',
      { site: 'bilibili', command: 'nope', args: {} }), res as any);
    expect(res.statusCode).toBe(400);
  });

  it('POST /login returns vncUrl', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/login', 'Bearer secret', { url: 'http://site' }), res as any);
    expect(JSON.parse(res.body).data.vncUrl).toBe('http://h:6080/vnc');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd gateway && npx vitest run src/rest.test.ts`
Expected: FAIL — `Cannot find module './rest.js'`

- [ ] **Step 3: 实现 rest.ts**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { Manifest } from './manifest.js';
import { buildArgs, type RunResult } from './opencli.js';

export interface Deps {
  cfg: Config;
  manifest: Manifest;
  run: (site: string, command: string, argv: string[]) => Promise<RunResult>;
  vnc: (opts: { url?: string }) => Promise<string>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
const ok = (res: ServerResponse, data: unknown) => send(res, 200, { ok: true, data });
const err = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { ok: false, error: { code, message } });

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const c of req) raw += c.toString();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function createRestHandler(deps: Deps) {
  const { cfg, manifest } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') return ok(res, { status: 'up' });

    // auth
    if (cfg.apiKey) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${cfg.apiKey}`) return err(res, 401, 'unauthorized', 'missing/invalid bearer');
    }

    try {
      if (method === 'GET' && path === '/sites') {
        const q = url.searchParams.get('q') ?? undefined;
        return ok(res, manifest.searchSites(q || undefined));
      }
      const helpMatch = path.match(/^\/sites\/([^/]+)\/help$/);
      if (method === 'GET' && helpMatch) {
        const site = decodeURIComponent(helpMatch[1]);
        const cmds = manifest.getSiteHelp(site);
        if (cmds.length === 0) return err(res, 404, 'unknown_site', `no such site: ${site}`);
        return ok(res, cmds);
      }
      if (method === 'POST' && path === '/run') {
        const b = await readBody(req);
        const { site, command, args = {} } = b;
        const record = manifest.findCommand(site, command);
        if (!record) return err(res, 400, 'unknown_command', `no such command: ${site} ${command}`);
        let argv: string[];
        try { argv = buildArgs(record, args); }
        catch (e) { return err(res, 400, 'bad_args', (e as Error).message); }
        const r = await deps.run(site, command, argv);
        if (!r.ok) return err(res, 502, 'opencli_error', r.stderr ?? 'unknown');
        return ok(res, r.data);
      }
      if (method === 'POST' && path === '/login') {
        const b = await readBody(req);
        const vncUrl = await deps.vnc({ url: b.url });
        return ok(res, { vncUrl });
      }
      return err(res, 404, 'not_found', `no route: ${method} ${path}`);
    } catch (e) {
      return err(res, 500, 'internal', (e as Error).message);
    }
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd gateway && npx vitest run src/rest.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/rest.ts gateway/src/rest.test.ts
git commit -m "feat(gateway): REST routes + bearer auth + envelope"
```

---

### Task 6: MCP 层(通用工具 + 10 一级站点工具)

**Files:**
- Create: `gateway/src/mcp.ts`
- Test: `gateway/src/mcp.test.ts`

**Interfaces:**
- Consumes: `Deps`(Task 5)、`Manifest`(Task 2)
- Produces:
  - `const PRIMARY_SITES: string[]`(10 个,verbatim from Global Constraints)
  - `function buildSiteToolDescription(manifest: Manifest, site: string): string` — 生成内嵌命令清单的工具描述文本(每行 `name — description`)。
  - `function createMcpServer(deps: Deps): McpServer` — 注册工具:`list_sites`、`site_help`、`run_command`、`browser`、`login`、`doctor`,以及 10 个 `<site>_command`;返回 SDK 的 `McpServer` 实例。
  - 说明:HTTP 挂载在 index.ts,用 SDK `StreamableHTTPServerTransport`。

- [ ] **Step 1: 写失败测试 mcp.test.ts**（只测纯函数,避免起 server）

```ts
import { describe, it, expect } from 'vitest';
import { PRIMARY_SITES, buildSiteToolDescription } from './mcp.js';
import { loadManifest } from './manifest.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadManifest(join(here, '__fixtures__', 'manifest.sample.json'));

describe('mcp helpers', () => {
  it('PRIMARY_SITES has exactly the 10 approved sites', () => {
    expect(PRIMARY_SITES).toEqual([
      'xiaohongshu','bilibili','twitter','reddit','zhihu',
      'douyin','weibo','youtube','hackernews','github',
    ]);
  });

  it('buildSiteToolDescription embeds command names', () => {
    const d = buildSiteToolDescription(manifest, 'bilibili');
    expect(d).toContain('search');
    expect(d).toContain('comment');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd gateway && npx vitest run src/mcp.test.ts`
Expected: FAIL — `Cannot find module './mcp.js'`

- [ ] **Step 3: 实现 mcp.ts**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from './rest.js';
import type { Manifest } from './manifest.js';
import { buildArgs } from './opencli.js';

export const PRIMARY_SITES = [
  'xiaohongshu', 'bilibili', 'twitter', 'reddit', 'zhihu',
  'douyin', 'weibo', 'youtube', 'hackernews', 'github',
];

export function buildSiteToolDescription(manifest: Manifest, site: string): string {
  const cmds = manifest.getSiteHelp(site);
  const lines = cmds.map((c) => `- ${c.name} — ${c.description}`);
  return `Run an opencli command for ${site}. Available commands:\n${lines.join('\n')}`;
}

async function runCmd(deps: Deps, site: string, command: string, args: Record<string, unknown>) {
  const record = deps.manifest.findCommand(site, command);
  if (!record) return { isError: true, content: [{ type: 'text' as const, text: `unknown command: ${site} ${command}` }] };
  let argv: string[];
  try { argv = buildArgs(record, args); }
  catch (e) { return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] }; }
  const r = await deps.run(site, command, argv);
  return { content: [{ type: 'text' as const, text: JSON.stringify(r.ok ? r.data : { error: r.stderr }) }] };
}

export function createMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'opencli-gateway', version: '0.1.0' });

  server.tool('list_sites', 'List/search available opencli sites (omit q for all)',
    { q: z.string().optional() },
    async ({ q }) => ({ content: [{ type: 'text', text: JSON.stringify(deps.manifest.searchSites(q)) }] }));

  server.tool('site_help', 'Show all commands + args for a site',
    { site: z.string() },
    async ({ site }) => ({ content: [{ type: 'text', text: JSON.stringify(deps.manifest.getSiteHelp(site)) }] }));

  server.tool('run_command', 'Run any opencli command',
    { site: z.string(), command: z.string(), args: z.record(z.unknown()).optional() },
    async ({ site, command, args }) => runCmd(deps, site, command, args ?? {}));

  server.tool('browser', 'Run an opencli browser primitive',
    { action: z.string(), args: z.record(z.unknown()).optional() },
    async ({ action, args }) => runCmd(deps, 'browser', action, args ?? {}));

  server.tool('login', 'Get a noVNC link to log into a site manually',
    { url: z.string().optional() },
    async ({ url }) => ({ content: [{ type: 'text', text: JSON.stringify({ vncUrl: await deps.vnc({ url }) }) }] }));

  server.tool('doctor', 'Run opencli doctor', {},
    async () => runCmd(deps, 'doctor', '', {}));

  for (const site of PRIMARY_SITES) {
    server.tool(`${site}_command`, buildSiteToolDescription(deps.manifest, site),
      { command: z.string(), args: z.record(z.unknown()).optional() },
      async ({ command, args }) => runCmd(deps, site, command, args ?? {}));
  }

  return server;
}
```

Note: 若 `zod` 未随 SDK 传递,需在 package.json 加 `"zod": "^3.23.0"` 到 dependencies(SDK peer)。实现本 task 时先 `cd gateway && npm i zod` 再写代码。

- [ ] **Step 4: 运行确认通过**

Run: `cd gateway && npm i zod && npx vitest run src/mcp.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/mcp.ts gateway/src/mcp.test.ts gateway/package.json gateway/package-lock.json
git commit -m "feat(gateway): MCP server with generic + 10 primary-site tools"
```

---

### Task 7: index.ts 启动 + 挂载 REST + MCP

**Files:**
- Create: `gateway/src/index.ts`

**Interfaces:**
- Consumes: 全部前置模块。
- Produces: 可执行入口。`GET/POST /mcp` 交给 MCP transport;其余交给 REST handler。

- [ ] **Step 1: 实现 index.ts**

```ts
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { loadManifest } from './manifest.js';
import { runOpencli } from './opencli.js';
import { getVncUrl } from './camofox-login.js';
import { createRestHandler, type Deps } from './rest.js';
import { createMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const cfg = loadConfig(process.env);
const manifest = loadManifest(cfg.manifestPath);

const deps: Deps = {
  cfg,
  manifest,
  run: (site, command, argv) => runOpencli(cfg.opencliBin, site, command, argv),
  vnc: (opts) => getVncUrl(cfg, opts),
};

const rest = createRestHandler(deps);
const mcpServer = createMcpServer(deps);
const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await mcpServer.connect(mcpTransport);

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/mcp') {
    // auth for MCP endpoint too
    if (cfg.apiKey && req.headers.authorization !== `Bearer ${cfg.apiKey}`) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad bearer' } }));
      return;
    }
    mcpTransport.handleRequest(req, res).catch((e) => {
      console.error('[gateway] mcp error', e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
    return;
  }
  rest(req, res).catch((e) => {
    console.error('[gateway] rest error', e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`[gateway] listening on 0.0.0.0:${cfg.port} (sites: ${manifest.listSites().length})`);
});
```

- [ ] **Step 2: 构建通过**

Run: `cd gateway && npm run build`
Expected: 无 TS 报错,生成 `dist/index.js`

- [ ] **Step 3: 全套测试通过**

Run: `cd gateway && npx vitest run`
Expected: PASS (全部 test 文件)

- [ ] **Step 4: 本地冒烟(用本仓 opencli manifest)**

Run:
```bash
cd gateway && OPENCLI_MANIFEST=../opencli/cli-manifest.json GATEWAY_API_KEY=dev node dist/index.js &
sleep 1
curl -s localhost:8080/health
curl -s -H "Authorization: Bearer dev" "localhost:8080/sites?q=bili"
kill %1
```
Expected: `/health` 返回 `{"ok":true,...}`;`/sites?q=bili` 返回含 bilibili 的数组。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/index.ts
git commit -m "feat(gateway): http entry wiring REST + MCP"
```

---

### Task 8: Python skill 公共客户端 + 脚本

**Files:**
- Create: `skills/opencli-camofox/scripts/_client.py`
- Create: `skills/opencli-camofox/scripts/list_sites.py`
- Create: `skills/opencli-camofox/scripts/site_help.py`
- Create: `skills/opencli-camofox/scripts/run.py`
- Create: `skills/opencli-camofox/scripts/browser.py`
- Create: `skills/opencli-camofox/scripts/vnc_login.py`
- Test: `skills/opencli-camofox/scripts/_client_test.py`

**Interfaces:**
- Produces: `_client.py` 暴露 `base_url()`, `api_key()`, `request(method, path, body=None) -> dict`。读 `OPENCLI_GATEWAY_URL`(默认 `http://localhost:8080`)与 `GATEWAY_API_KEY`,支持从 `~/.opencli-gateway.env` 加载。

- [ ] **Step 1: 写失败测试 _client_test.py**（纯函数:url 归一 + header 构造）

```python
import os, sys, importlib.util
spec = importlib.util.spec_from_file_location(
    "_client", os.path.join(os.path.dirname(__file__), "_client.py"))
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

def test_base_url_default(monkeypatch=None):
    os.environ.pop("OPENCLI_GATEWAY_URL", None)
    assert c.base_url() == "http://localhost:8080"

def test_base_url_strips_slash():
    os.environ["OPENCLI_GATEWAY_URL"] = "http://x:8080/"
    assert c.base_url() == "http://x:8080"

def test_headers_include_bearer():
    os.environ["GATEWAY_API_KEY"] = "k"
    h = c.build_headers()
    assert h["Authorization"] == "Bearer k"

if __name__ == "__main__":
    test_base_url_default(); test_base_url_strips_slash(); test_headers_include_bearer()
    print("ok")
```

- [ ] **Step 2: 运行确认失败**

Run: `python skills/opencli-camofox/scripts/_client_test.py`
Expected: FAIL — `No module named '_client'` / AttributeError

- [ ] **Step 3: 实现 _client.py**

```python
"""Shared HTTP client for the opencli-camofox skill (stdlib only)."""
import json
import os
import urllib.request
import urllib.error

def _load_dotenv():
    if os.environ.get("OPENCLI_GATEWAY_URL") and os.environ.get("GATEWAY_API_KEY"):
        return
    path = os.path.join(os.path.expanduser("~"), ".opencli-gateway.env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip(); v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)

_load_dotenv()

def base_url():
    return (os.environ.get("OPENCLI_GATEWAY_URL") or "http://localhost:8080").rstrip("/")

def api_key():
    return (os.environ.get("GATEWAY_API_KEY") or "").strip()

def build_headers():
    h = {"Content-Type": "application/json"}
    k = api_key()
    if k:
        h["Authorization"] = f"Bearer {k}"
    return h

def request(method, path, body=None, timeout=120):
    url = f"{base_url()}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=build_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except Exception:
            return {"ok": False, "error": {"code": f"http_{e.code}", "message": body[:300]}}
```

- [ ] **Step 4: 运行确认通过**

Run: `python skills/opencli-camofox/scripts/_client_test.py`
Expected: 打印 `ok`

- [ ] **Step 5: 实现 4 个命令脚本**

`list_sites.py`:
```python
"""List/search opencli sites. Usage: python list_sites.py [query]"""
import json, sys
from _client import request
q = sys.argv[1] if len(sys.argv) > 1 else None
path = f"/sites?q={q}" if q else "/sites"
print(json.dumps(request("GET", path), ensure_ascii=False, indent=2))
```

`site_help.py`:
```python
"""Show commands for a site. Usage: python site_help.py <site>"""
import json, sys
from _client import request
if len(sys.argv) < 2:
    print("usage: site_help.py <site>", file=sys.stderr); sys.exit(1)
print(json.dumps(request("GET", f"/sites/{sys.argv[1]}/help"), ensure_ascii=False, indent=2))
```

`run.py`:
```python
"""Run an opencli command.
Usage: python run.py <site> <command> [--key value | --flag] ...
Values that look like ints are sent as ints; bare --flag sends true."""
import json, sys
from _client import request

def parse(argv):
    args = {}
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("--"):
            key = tok[2:]
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                val = argv[i + 1]
                args[key] = int(val) if val.lstrip("-").isdigit() else val
                i += 2
            else:
                args[key] = True
                i += 1
        else:
            i += 1
    return args

if len(sys.argv) < 3:
    print("usage: run.py <site> <command> [--key value]...", file=sys.stderr); sys.exit(1)
site, command = sys.argv[1], sys.argv[2]
body = {"site": site, "command": command, "args": parse(sys.argv[3:])}
print(json.dumps(request("POST", "/run", body), ensure_ascii=False, indent=2))
```

`browser.py`:
```python
"""Run an opencli browser primitive via /run with site=browser.
Usage: python browser.py <action> [--key value | --flag] ..."""
import json, sys
from _client import request
sys.path.insert(0, __import__("os").path.dirname(__file__))
from run import parse  # reuse arg parser
if len(sys.argv) < 2:
    print("usage: browser.py <action> [--key value]...", file=sys.stderr); sys.exit(1)
action = sys.argv[1]
body = {"site": "browser", "command": action, "args": parse(sys.argv[2:])}
print(json.dumps(request("POST", "/run", body), ensure_ascii=False, indent=2))
```

`vnc_login.py`:
```python
"""Get a noVNC link to log into a site manually.
Usage: python vnc_login.py [--url TARGET_URL]"""
import json, sys
from _client import request
url = None
if "--url" in sys.argv:
    i = sys.argv.index("--url")
    if i + 1 < len(sys.argv):
        url = sys.argv[i + 1]
body = {"url": url} if url else {}
res = request("POST", "/login", body)
if res.get("ok"):
    print(res["data"]["vncUrl"])
else:
    print(json.dumps(res, ensure_ascii=False), file=sys.stderr); sys.exit(1)
```

- [ ] **Step 6: 冒烟(需 Task 7 网关在跑)**

Run:
```bash
export OPENCLI_GATEWAY_URL=http://localhost:8080 GATEWAY_API_KEY=dev
python skills/opencli-camofox/scripts/list_sites.py bili
```
Expected: 打印含 bilibili 的 JSON envelope。

- [ ] **Step 7: 提交**

```bash
git add skills/opencli-camofox/scripts/
git commit -m "feat(skill): python http client + command scripts"
```

---

### Task 9: SKILL.md + references

**Files:**
- Create: `skills/opencli-camofox/SKILL.md`
- Create: `skills/opencli-camofox/references/gateway-api.md`

**Interfaces:**
- Consumes: Task 8 脚本。
- Produces: 可被 agent 装载的 skill 文档。

- [ ] **Step 1: 写 SKILL.md**

````markdown
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
   - Positional args are passed by `--name value` too; the gateway orders them.
4. **Generic browser control** (any page): `python scripts/browser.py <action> [...]`
   - Actions: navigate, click, type, scroll, snapshot, screenshot, get, etc.
5. **Login wall / CAPTCHA / Cloudflare**: `python scripts/vnc_login.py [--url URL]`
   - Prints a noVNC URL. **Share it with the user** to log in manually.
   - Do NOT ask the user for passwords/OTP in chat. Do NOT try to solve CAPTCHAs.
   - After the user confirms login, re-run the original command; cookies persist.

## Notes

- Every response is a JSON envelope `{ok, data?, error?}`.
- On `unknown_command`, run `site_help.py` first.
- On auth errors (401), check `GATEWAY_API_KEY`.
- See `references/gateway-api.md` for the full endpoint reference.
````

- [ ] **Step 2: 写 references/gateway-api.md**

```markdown
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

## MCP tools
- Generic: `list_sites(q?)`, `site_help(site)`, `run_command(site,command,args)`,
  `browser(action,args)`, `login(url?)`, `doctor()`
- Primary-site direct tools (embed their command list in the description):
  `xiaohongshu_command, bilibili_command, twitter_command, reddit_command,
  zhihu_command, douyin_command, weibo_command, youtube_command,
  hackernews_command, github_command` — each takes `{command, args}`.
- Other ~160 sites: use `list_sites` → `site_help` → `run_command`.
```

- [ ] **Step 3: 提交**

```bash
git add skills/opencli-camofox/SKILL.md skills/opencli-camofox/references/
git commit -m "docs(skill): SKILL.md + gateway API reference"
```

---

### Task 10: 部署(Dockerfile + supervisord + compose)

**Files:**
- Modify: `Dockerfile`
- Modify: `supervisord.conf`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: Task 7 网关产物。
- Produces: 容器内 `/opt/gateway/` + supervisord 进程 + `:8080` 映射。

- [ ] **Step 1: Dockerfile 加 gateway 构建 stage**

在现有 `shim-build` stage 之后、`Stage 3` 之前插入:

```dockerfile
# ─── Stage 2b: Build OpenCLI Gateway ──────────────────────────────
FROM node:22-slim AS gateway-build

WORKDIR /app
COPY camofox-shim/gateway/package.json camofox-shim/gateway/package-lock.json ./
RUN npm ci
COPY camofox-shim/gateway/ ./
RUN npx tsc
```

在 Stage 3 的 `# ── Install Shim ──` 段之后插入:

```dockerfile
# ── Install Gateway ───────────────────────────────────────────────
COPY --from=gateway-build /app/dist /opt/gateway/dist
COPY --from=gateway-build /app/node_modules /opt/gateway/node_modules
COPY --from=gateway-build /app/package.json /opt/gateway/
```

在现有 `ENV SHIM_PORT=19825` 后加:

```dockerfile
ENV GATEWAY_PORT=8080
ENV OPENCLI_MANIFEST=/opt/opencli/cli-manifest.json
```

并把 `EXPOSE 9377 6080 19825` 改为 `EXPOSE 9377 6080 19825 8080`。

- [ ] **Step 2: supervisord.conf 加 gateway 进程**

在文件末尾追加:

```ini
[program:gateway]
command=node /opt/gateway/dist/index.js
user=node
autostart=true
autorestart=true
startsecs=5
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=4
depends_on=opencli-daemon
```

- [ ] **Step 3: docker-compose.yml 加端口 + env**

`ports` 段加一行 `- "8080:8080"`。
`environment` 段加:

```yaml
      # Gateway
      GATEWAY_PORT: "8080"
      GATEWAY_API_KEY: "change_me_gateway_key"
      OPENCLI_MANIFEST: "/opt/opencli/cli-manifest.json"
```

（`CAMOFOX_URL` / `CAMOFOX_API_KEY` / `CAMOFOX_USER_ID` 已存在,网关复用。）

- [ ] **Step 4: 构建镜像**

Run: `docker compose build`
Expected: 三个 build stage 成功,无报错。

- [ ] **Step 5: 起容器并端到端验证**

Run:
```bash
docker compose up -d
sleep 15
curl -s localhost:8080/health
curl -s -H "Authorization: Bearer change_me_gateway_key" "localhost:8080/sites?q=hackernews"
curl -s -H "Authorization: Bearer change_me_gateway_key" -X POST localhost:8080/run \
  -H "Content-Type: application/json" -d '{"site":"hackernews","command":"top","args":{}}'
```
Expected:
- `/health` → `{"ok":true,...}`
- `/sites?q=hackernews` → 含 hackernews 的数组
- `/run` hackernews top(Tier1 免登录)→ `{"ok":true,"data":...}` 带真实条目

- [ ] **Step 6: 提交**

```bash
git add Dockerfile supervisord.conf docker-compose.yml
git commit -m "feat(deploy): add gateway to image, supervisord, compose :8080"
```

---

### Task 11: 更新 CLAUDE.md + DESIGN.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `DESIGN.md`

- [ ] **Step 1: CLAUDE.md 加网关章节**

在 "## Docker" 之前或架构章节后追加一节 "## Gateway (opencli 对外暴露)",说明:
- `gateway/` 是 Node/TS 服务,容器内 `:8080`,提供 REST + 内置 MCP(`/mcp`)。
- 通过 spawn `opencli … --format json` 执行,发现走 `cli-manifest.json`。
- 鉴权 `GATEWAY_API_KEY`;`/health` 免鉴权。
- skill 在 `skills/opencli-camofox/`(Python stdlib)。
- 加命令无需改网关:manifest 里有即可 `/run`;10 个一级站点在 `mcp.ts` 的 `PRIMARY_SITES`。

- [ ] **Step 2: DESIGN.md 加网关小节**

在架构图后补充 gateway 层(:8080)与 REST/MCP 端点表,并在决策记录追加 G1–G7(从 spec 复制)。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md DESIGN.md
git commit -m "docs: document gateway + skill + MCP"
```

---

## Self-Review

**Spec coverage:**
- REST 端点(sites/help/run/login/health)→ Task 5 ✓;doctor/browser 通过 `/run` 复用(spec 8 允许 browser 作为 run 特例)→ Task 5/6/8 ✓
- 内置 MCP + 渐进式披露 + 10 一级站点 → Task 6 ✓
- API key 鉴权 + envelope → Task 5、Task 7(/mcp 也鉴权)✓
- login 移植 toggle-display → Task 4 ✓
- Python stdlib skill 覆盖全部能力 → Task 8/9 ✓
- 部署(Dockerfile/supervisord/compose)→ Task 10 ✓
- 发现数据源 cli-manifest.json → Task 2 ✓
- 文档 → Task 11 ✓

**Placeholder scan:** 无 TBD/TODO;每个代码步骤含完整代码;命令含预期输出。Task 11 步骤是文档编辑,给出了明确章节要点(非代码步骤,可接受)。

**Type consistency:** `Config`(Task1)、`CmdRecord/Manifest`(Task2)、`RunResult/buildArgs/runOpencli`(Task3)、`getVncUrl`(Task4)、`Deps/createRestHandler`(Task5)、`PRIMARY_SITES/createMcpServer`(Task6)在各任务签名一致;`run` 依赖注入签名 `(site,command,argv)=>Promise<RunResult>` 在 Task5/6/7 统一。

**已知风险(实现时验证):**
- `@modelcontextprotocol/sdk` 的 `McpServer` / `StreamableHTTPServerTransport` 导入路径以实际安装版本为准;若 API 有出入,Task 6/7 按 SDK 文档微调(用 context7 查 `@modelcontextprotocol/sdk`)。
- opencli `browser`/`doctor` 是否走 `<site> <command>` 同一 spawn 形态需在 Task 10 冒烟确认;若 `doctor` 是顶层子命令(`opencli doctor` 无 site),Task 3 的 runOpencli 需支持 command 为空时不传空串——实现时在 `runOpencli` 内过滤空 `command`。





