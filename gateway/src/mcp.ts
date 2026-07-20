import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from './rest.js';
import type { Manifest } from './manifest.js';
import { buildArgs, PASSTHROUGH_SITES, type RunResult } from './opencli.js';
import { log } from './logger.js';
import * as searchCache from './search-cache.js';

export const PRIMARY_SITES = [
  'xiaohongshu', 'bilibili', 'twitter', 'reddit', 'zhihu',
  'douyin', 'weibo', 'youtube', 'hackernews', 'github',
];

export function buildSiteToolDescription(manifest: Manifest, site: string): string {
  const cmds = manifest.getSiteHelp(site);
  const lines = cmds.map((c) => `- ${c.name} — ${c.description}`);
  return `Run an opencli command for ${site}. Available commands:\n${lines.join('\n')}`;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function textErr(msg: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

function isAuthRequired(r: RunResult): boolean {
  if (r.ok) return false;
  const data = r.data as { error?: { code?: string } } | undefined;
  return data?.error?.code === 'AUTH_REQUIRED';
}

/**
 * Translate the cross-site `search` MCP tool's normalised input into the
 * underlying `<site> search` opencli command, using the startup-time
 * search-cache to honour whatever name the adapter wants for its primary
 * positional, plus validate that any `extras` keys match the manifest.
 *
 * Errors are returned as a structured envelope with `{ error: { code,
 * message, hint, knownKeys } }` so the LLM can correct the call instead
 * of guessing.
 */
async function handleSearch(
  deps: Deps,
  site: string,
  query: string,
  limit: number | undefined,
  extras: Record<string, unknown>,
  clientHost: string | null,
): Promise<ToolResult> {
  const entry = searchCache.get(site);
  if (!entry) {
    const known = deps.manifest
      .listSites()
      .filter((s) => searchCache.hasSite(s))
      .slice(0, 20);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: false,
          data: {
            error: {
              code: 'NO_SEARCH_COMMAND',
              message: `${site} has no search command; use \`site_help(site: \"${site}\")\` to see available commands`,
              knownSearchSites: known,
            },
          },
        }),
      }],
    };
  }

  // Reject unknown `extras` keys before spawning so the LLM gets a
  // meaningful "did you mean" hint instead of an opencli error.
  const allowedNames = new Set<string>([
    entry.firstPositional,
    ...entry.otherPositionals,
    ...entry.flagSpec.keys(),
  ]);
  const unknown: string[] = [];
  for (const k of Object.keys(extras)) {
    if (!allowedNames.has(k)) unknown.push(k);
  }
  if (unknown.length) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: false,
          data: {
            error: {
              code: 'UNKNOWN_ARGS',
              message: `${site} search does not accept: ${unknown.join(', ')}`,
              hint: `Pass the value under one of the manifest names instead.`,
              knownKeys: [...allowedNames],
            },
          },
        }),
      }],
    };
  }

  // Build the args object the way buildArgs expects:
  //   { [firstPositional]: query, ...otherPositionals, ...flagSpec entries }
  const composedArgs: Record<string, unknown> = { ...extras };
  composedArgs[entry.firstPositional] = query;
  if (limit !== undefined) {
    composedArgs.limit = limit;
  }
  return runCmd(deps, site, 'search', composedArgs, clientHost);
}

async function runCmd(
  deps: Deps,
  site: string,
  command: string,
  args: Record<string, unknown>,
  clientHost: string | null,
): Promise<ToolResult> {
  const t0 = Date.now();
  log.info('mcp.run.start', { site, command, args });
  // Browser primitives are intentionally not exposed over MCP — the gateway
  // only drives the 173+ site content adapters. Reject any attempt to reach
  // the passthrough browser via run_command.
  if (PASSTHROUGH_SITES.has(site)) {
    return textErr(`site not available over MCP: ${site}`);
  }
  let argv: string[];
  const passthrough = false;
  {
    const record = deps.manifest.findCommand(site, command);
    if (!record) return textErr(`unknown command: ${site} ${command}`);
    // Self-heal UX: `<site> login` blocks until cookies appear or its timeout
    // expires (default 300s = 5min in many adapters). From the MCP client's
    // perspective that locks the UI for minutes. Inject a sensible default
    // — 30s — when the caller didn't specify one; user-supplied timeout wins.
    const augmentedArgs = (command === 'login' && args.timeout === undefined)
      ? { ...args, timeout: 30 }
      : args;
    try { argv = buildArgs(record, augmentedArgs); }
    catch (e) { return textErr((e as Error).message); }
  }
  const r = await deps.run(site, command, argv, { passthrough });
  const ms = Date.now() - t0;
  if (isAuthRequired(r)) {
    const url = (r.data as { error?: { help?: string } }).error?.help?.match(/https?:\/\/\S+/)?.[0];
    const vncUrl = await deps.vnc({ url, clientHost: clientHost ?? undefined });
    log.warn('mcp.run.auth_required', { site, command, ms, vncUrl });
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: (r.data as { error: unknown }).error,
          vncUrl,
          hint: 'Open the VNC link, log in, then re-run this command.',
        }),
      }],
    };
  }
  log.info('mcp.run.done', { site, command, ms, ok: r.ok, stderr: r.ok ? undefined : r.stderr });
  return { content: [{ type: 'text', text: JSON.stringify(r.ok ? r.data : { error: r.stderr ?? r.data }) }] };
}

/**
 * Per-request client host. The Streamable HTTP transport doesn't pass `req`
 * into tool handlers, so the HTTP layer (index.ts) constructs a fresh server
 * per request and passes the inbound Host here — no shared global state, so
 * concurrent requests can't clobber each other's host.
 */
export interface ServerCtx { clientHost: string | null }

export function createMcpServer(deps: Deps, ctx: ServerCtx = { clientHost: null }): McpServer {
  const server = new McpServer({ name: 'opencli-gateway', version: '0.1.0' });

  server.registerTool('list_sites',
    { description: 'List/search available opencli sites (omit q for all)', inputSchema: { q: z.string().optional() } },
    async ({ q }) => ({ content: [{ type: 'text', text: JSON.stringify(deps.manifest.searchSites(q)) }] }));

  server.registerTool('site_help',
    { description: 'Show all commands + args for a site', inputSchema: { site: z.string() } },
    async ({ site }) => ({ content: [{ type: 'text', text: JSON.stringify(deps.manifest.getSiteHelp(site)) }] }));

  server.registerTool('run_command',
    { description: 'Run any opencli command', inputSchema: { site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).optional() } },
    async ({ site, command, args }) => runCmd(deps, site, command, args ?? {}, ctx.clientHost));

  // Cross-site search wrapper. Accepts a normalised {site, query, limit, extras}
  // shape and uses the search-cache to map `query` onto whatever the adapter
  // actually calls its primary positional (query/keyword/q/text/term).
  server.registerTool('search',
    {
      description:
        'Run a search across any of the 173 supported sites. Pass the site slug ' +
        'and a `query` string. `limit` is shorthand for the most common --limit ' +
        'flag (always an int). `extras` holds any other adapter-specific args ' +
        '(sort, time, type, etc.) — server validates them against that site\'s ' +
        'manifest and returns a clear error if you send an unknown key. Aliases ' +
        'for the primary query positional (keyword/q/text) are accepted.\n\n' +
        'Returns the opencli envelope. When the site requires login the response ' +
        'includes a `vncUrl` you should surface to the user.',
      inputSchema: {
        site: z.string().describe('Site slug (e.g. "bilibili", "twitter", "douyin")'),
        query: z.string().describe('Primary search term — server resolves to the adapter\'s positional name'),
        limit: z.number().int().positive().optional().describe('Result count (most adapters accept --limit; omit to use adapter default)'),
        extras: z.record(z.string(), z.unknown()).optional().describe('Other adapter args (sort/time/type/etc.). Keys must match the adapter\'s manifest; unknown keys are rejected with a clear error.'),
      },
    },
    async ({ site, query, limit, extras }) => handleSearch(deps, site, query, limit, extras ?? {}, ctx.clientHost));

  server.registerTool('login',
    { description: 'Get a noVNC link to log into a site manually', inputSchema: { url: z.string().optional() } },
    async ({ url }) => ({ content: [{ type: 'text', text: JSON.stringify({ vncUrl: await deps.vnc({ url, clientHost: ctx.clientHost ?? undefined }) }) }] }));

  server.registerTool('doctor',
    { description: 'Run opencli doctor', inputSchema: {} },
    async () => runCmd(deps, 'doctor', '', {}, ctx.clientHost));

  for (const site of PRIMARY_SITES) {
    server.registerTool(`${site}_command`,
      { description: buildSiteToolDescription(deps.manifest, site), inputSchema: { command: z.string(), args: z.record(z.string(), z.unknown()).optional() } },
      async ({ command, args }) => runCmd(deps, site, command, args ?? {}, ctx.clientHost));
  }

  return server;
}
