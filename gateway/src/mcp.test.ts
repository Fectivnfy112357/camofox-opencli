import { describe, it, expect, vi } from 'vitest';
import { PRIMARY_SITES, buildSiteToolDescription, createMcpServer } from './mcp.js';
import { loadManifest } from './manifest.js';
import { buildRawArgs, PASSTHROUGH_SITES, type RunResult } from './opencli.js';
import * as searchCache from './search-cache.js';
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

describe('browser tool argv', () => {
  it('browser is a passthrough site', () => {
    expect(PASSTHROUGH_SITES.has('browser')).toBe(true);
  });

  it('browser open with session + url marks hasSession=true', () => {
    const r = buildRawArgs({ session: 'work', _: ['https://x.com'] });
    expect(r.positionals).toEqual(['work', 'https://x.com']);
    expect(r.hasSession).toBe(true);
  });

  it('browser state with only session marks hasSession=true', () => {
    const r = buildRawArgs({ session: 'work' });
    expect(r.positionals).toEqual(['work']);
    expect(r.hasSession).toBe(true);
  });

  it('browser navigate with positional but no session has hasSession=false', () => {
    const r = buildRawArgs({ _: ['http://x'] });
    expect(r.positionals).toEqual(['http://x']);
    expect(r.hasSession).toBe(false);
  });
});

// End-to-end MCP handler test: register the `browser` tool against a real
// McpServer, invoke its registered handler with the same payload shape an MCP
// client would send, and capture the argv passed to `run`. This proves the
// MCP layer translates {action, session, positional, args} into the right
// CLI argv — not the broken legacy shape of dumping args as flags.
describe('MCP browser tool handler', () => {
  it('browser open: action=open + session=work + positional=[url] spawns argv=[session,open,url]', async () => {
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    // The MCP SDK exposes registered tools via `server._registeredTools` (private but stable).
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    const browserTool = tools.browser;
    expect(browserTool).toBeDefined();
    const result = await browserTool.handler({
      action: 'open',
      session: 'work',
      positional: ['https://x.com'],
    });
    expect(run).toHaveBeenCalledWith('browser', 'open', ['work', 'open', 'https://x.com'], { passthrough: true });
    expect(JSON.parse(result.content[0].text).argv).toEqual(['work', 'open', 'https://x.com']);
  });

  it('browser click: action=click + session=work + positional=[ref] spawns argv=[session,click,ref]', async () => {
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.browser.handler({
      action: 'click',
      session: 'work',
      positional: ['12'],
    });
    expect(run).toHaveBeenCalledWith('browser', 'click', ['work', 'click', '12'], { passthrough: true });
  });

  it('run_command: <site> login injects default --timeout 30 (UX: avoid 5min lock)', async () => {
    const fakeManifest = {
      findCommand: (_site: string, _cmd: string) => ({
        site: 'kimi', name: 'login', access: 'write',
        args: [{ name: 'timeout', type: 'int', positional: false, default: 300 }],
      }),
      getSiteHelp: () => [],
      listSites: () => [],
      searchSites: () => [],
    } as any;
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest: fakeManifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.run_command.handler({ site: 'kimi', command: 'login', args: {} });
    expect(run).toHaveBeenCalledWith('kimi', 'login', ['--timeout', '30', '--format', 'json'], { passthrough: false });
  });

  it('run_command: <site> login honours user-supplied timeout (no override)', async () => {
    const fakeManifest = {
      findCommand: (_site: string, _cmd: string) => ({
        site: 'kimi', name: 'login', access: 'write',
        args: [{ name: 'timeout', type: 'int', positional: false, default: 300 }],
      }),
      getSiteHelp: () => [],
      listSites: () => [],
      searchSites: () => [],
    } as any;
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest: fakeManifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.run_command.handler({ site: 'kimi', command: 'login', args: { timeout: 90 } });
    expect(run).toHaveBeenCalledWith('kimi', 'login', ['--timeout', '90', '--format', 'json'], { passthrough: false });
  });

  it('browser state: action=state + session=work + positional=[] spawns argv=[session,state]', async () => {
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.browser.handler({
      action: 'state',
      session: 'work',
      positional: [],
    });
    expect(run).toHaveBeenCalledWith('browser', 'state', ['work', 'state'], { passthrough: true });
  });

  it('browser open: positional arrives as record {0:...,1:...} (MCP client quirk) — sorted by key', async () => {
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.browser.handler({
      action: 'open',
      session: 'work',
      // some MCP clients serialise arrays as {0:"a",1:"b"} objects
      positional: { 0: 'https://x.com' },
    });
    expect(run).toHaveBeenCalledWith('browser', 'open', ['work', 'open', 'https://x.com'], { passthrough: true });
  });

  it('browser open: bare string positional accepted; single URL forwarded as a single positional', async () => {
    // WHY THIS TEST EXISTS: the report C:\Users\32115\camfox-opencli-test-report.md
    // §3.6.2 saw "expected array, received string" — Claude Code MCP client
    // serialises array fields as a bare string when there's one element. The
    // schema (mcp.ts:126) now accepts z.string() and the handler (mcp.ts:151)
    // forwards it as a single positional so `opencli browser <sess> open <url>`
    // is correctly assembled.
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.browser.handler({
      action: 'open',
      session: 'work',
      positional: 'https://kimi.com/pricing', // single-URL string, not an array
    });
    expect(run).toHaveBeenCalledWith('browser', 'open', ['work', 'open', 'https://kimi.com/pricing'], { passthrough: true });
  });

  it('browser open: JSON-array string positional (multi-element client quirk) parses into multiple positionals', async () => {
    // WHY THIS TEST EXISTS: same client quirk as above, but for >1 element
    // where Claude Code stringifies the array. e.g. `["https://a", "https://b"]`
    // arrives as the string `"[\"https://a\",\"https://b\"]"`.
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.browser.handler({
      action: 'open',
      session: 'work',
      positional: JSON.stringify(['https://a.example', 'https://b.example']),
    });
    expect(run).toHaveBeenCalledWith(
      'browser',
      'open',
      ['work', 'open', 'https://a.example', 'https://b.example'],
      { passthrough: true }
    );
  });

  it('browser open: Claude Code quirk — positional value lands in args.positional as string/array, hoisted into argv positionals', async () => {
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    // MCP clients (e.g. Claude Code) cannot populate top-level array fields
    // via the tool UI and end up stuffing the value into `args.<fieldname>`
    // which would otherwise become a literal `--positional` flag.
    await tools.browser.handler({
      action: 'open',
      session: 'work',
      args: { positional: 'https://x.com' },
    });
    expect(run).toHaveBeenCalledWith('browser', 'open', ['work', 'open', 'https://x.com'], { passthrough: true });
  });

  it('browser click: positional accepts numeric refs (stringified)', async () => {
    const run = vi.fn(async (_site: string, _cmd: string, argv: string[]): Promise<RunResult> => {
      return { ok: true, data: { argv } };
    });
    const server = createMcpServer({ cfg: {} as any, manifest, run, vnc: async () => '' });
    const tools = (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
    await tools.browser.handler({
      action: 'click',
      session: 'work',
      positional: [12], // numeric ref — CLI wants string
    });
    expect(run).toHaveBeenCalledWith('browser', 'click', ['work', 'click', '12'], { passthrough: true });
  });
});

// Cross-site search MCP tool. The handler pulls `search-cache` keyed on
// site, so each test must rebuild the cache with a manifest that exposes
// the corresponding search record.
describe('MCP search tool handler', () => {
  // Imports live at top — co-locate cache reset for clarity.
  function withManifest(records: Array<{ site: string; name: string; args: { name: string; type: string; required: boolean; positional: boolean }[] }>) {
    searchCache.__resetForTests();
    searchCache.build({
      listSites: () => [...new Set(records.map((r) => r.site))],
      searchSites: () => [],
      getSiteHelp: (site: string) => records.filter((r) => r.site === site),
      findCommand: (site: string, command: string) =>
        records.find((r) => r.site === site && r.name === command),
    } as any);
  }
  function tools() {
    const server = createMcpServer({ cfg: {} as any, manifest: {} as any, run: () => ({} as any), vnc: async () => '' });
    return (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
  }
  function parseBody(r: any) { return JSON.parse(r.content[0].text); }

  it('forwards canonical positional to <site> search spawn', async () => {
    const rec = {
      site: 'bilibili', name: 'search',
      args: [{ name: 'query', type: 'str', required: true, positional: true }],
    };
    searchCache.__resetForTests();
    searchCache.build({
      listSites: () => ['bilibili'],
      searchSites: () => [],
      getSiteHelp: () => [rec],
      findCommand: (_s: string, _c: string) => rec,
    } as any);
    const fullManifest: any = {
      listSites: () => ['bilibili'],
      searchSites: () => [{ site: 'bilibili', commands: 1 }],
      getSiteHelp: () => [],
      findCommand: () => rec,
    };
    const run = vi.fn(async (_s: string, _c: string, argv: string[]) => ({ ok: true, data: { argv } }));
    const server = createMcpServer({ cfg: {} as any, manifest: fullManifest, run, vnc: async () => '' });
    const t = (server as any)._registeredTools as any;
    const r = await t.search.handler({ site: 'bilibili', query: 'Kimi K3' });
    expect(run).toHaveBeenCalledWith('bilibili', 'search', ['Kimi K3', '--format', 'json'], { passthrough: false });
    expect(parseBody(r).argv).toEqual(['Kimi K3', '--format', 'json']);
  });

  it('accepts keyword/q/text aliases and maps to the actual positional name', async () => {
    const rec = {
      site: 'douyin', name: 'search',
      args: [{ name: 'keyword', type: 'str', required: true, positional: true }],
    };
    searchCache.__resetForTests();
    searchCache.build({
      listSites: () => ['douyin'],
      searchSites: () => [],
      getSiteHelp: () => [rec],
      findCommand: () => rec,
    } as any);
    const fullManifest: any = {
      listSites: () => ['douyin'],
      searchSites: () => [{ site: 'douyin', commands: 1 }],
      getSiteHelp: () => [],
      findCommand: () => rec,
    };
    const run = vi.fn(async () => ({ ok: true, data: { ok: true } }));
    const server = createMcpServer({ cfg: {} as any, manifest: fullManifest, run, vnc: async () => '' });
    const t = (server as any)._registeredTools as any;
    await t.search.handler({ site: 'douyin', query: 'autonomous' });
    expect(run).toHaveBeenCalledWith('douyin', 'search', ['autonomous', '--format', 'json'], { passthrough: false });
  });

  it('passes `limit` through as --limit flag', async () => {
    const rec = {
      site: 'youtube', name: 'search',
      args: [
        { name: 'query', type: 'str', required: true, positional: true },
        { name: 'limit', type: 'int', required: false, positional: false },
      ],
    };
    searchCache.__resetForTests();
    searchCache.build({
      listSites: () => ['youtube'],
      searchSites: () => [],
      getSiteHelp: () => [rec],
      findCommand: () => rec,
    } as any);
    const fullManifest: any = {
      listSites: () => ['youtube'],
      searchSites: () => [{ site: 'youtube', commands: 1 }],
      getSiteHelp: () => [],
      findCommand: () => rec,
    };
    const run = vi.fn(async () => ({ ok: true, data: {} }));
    const server = createMcpServer({ cfg: {} as any, manifest: fullManifest, run, vnc: async () => '' });
    const t = (server as any)._registeredTools as any;
    await t.search.handler({ site: 'youtube', query: 'kimi', limit: 10 });
    expect(run).toHaveBeenCalledWith('youtube', 'search',
      ['kimi', '--limit', '10', '--format', 'json'], { passthrough: false });
  });

  it('validates extras keys against manifest; unknown ones return clear error', async () => {
    withManifest([{
      site: 'zhihu', name: 'search',
      args: [
        { name: 'query', type: 'str', required: true, positional: true },
        { name: 'sort', type: 'str', required: false, positional: false },
      ],
    }]);
    const fullManifest: any = {
      listSites: () => ['zhihu'],
      searchSites: () => [{ site: 'zhihu', commands: 1 }],
      getSiteHelp: () => [],
      findCommand: () => undefined,
    };
    const run = vi.fn();
    const server = createMcpServer({ cfg: {} as any, manifest: fullManifest, run, vnc: async () => '' });
    const t = (server as any)._registeredTools as any;
    const r = await t.search.handler({ site: 'zhihu', query: 'kimi', extras: { foo: 'bar' } });
    expect(run).not.toHaveBeenCalled();
    const body = parseBody(r);
    expect(body.data.error.code).toBe('UNKNOWN_ARGS');
    expect(body.data.error.knownKeys.sort()).toEqual(['query', 'sort']);
  });

  it('reports NO_SEARCH_COMMAND for sites without `search`', async () => {
    withManifest([]); // empty cache
    const fullManifest: any = {
      listSites: () => [],
      searchSites: () => [],
      getSiteHelp: () => [],
      findCommand: () => undefined,
    };
    const run = vi.fn();
    const server = createMcpServer({ cfg: {} as any, manifest: fullManifest, run, vnc: async () => '' });
    const t = (server as any)._registeredTools as any;
    const r = await t.search.handler({ site: 'kimi', query: 'k3' });
    expect(run).not.toHaveBeenCalled();
    const body = parseBody(r);
    expect(body.data.error.code).toBe('NO_SEARCH_COMMAND');
    expect(body.data.error.message).toContain('kimi');
  });
});
