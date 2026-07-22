import { describe, it, expect, vi } from 'vitest';
import { PRIMARY_SITES, buildSiteToolDescription, createMcpServer } from '../../src/gateway/mcp/mcp.js';
import { loadManifest } from '../../src/gateway/core/manifest.js';
import { type RunResult } from '../../src/gateway/core/opencli.js';
import * as searchCache from '../../src/gateway/core/search-cache.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadManifest(join(here, '..', '__fixtures__', 'manifest.sample.json'));

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

// MCP handler tests: register tools against a real McpServer and invoke the
// registered handler with the payload shape an MCP client would send.
describe('MCP run_command tool handler', () => {
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
