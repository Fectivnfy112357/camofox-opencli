import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from './rest.js';
import type { Manifest } from './manifest.js';
import { buildArgs, buildRawArgs, PASSTHROUGH_SITES, type RunResult } from './opencli.js';
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
  let argv: string[];
  let passthrough = false;
  if (PASSTHROUGH_SITES.has(site)) {
    // For browser: argv layout depends on whether the caller passed a session.
    //   with session: [session, command, ...rest-positionals, --flags]
    //   without session: [command, ...positionals, --flags]
    // `command` (the opencli subcommand, e.g. "open"/"click"/"state") is
    // spliced in as the second positional after session, or as the first
    // positional when no session — so the CLI sees:
    //   opencli browser <session> <command> <rest-positionals> --flags
    const { positionals, flags, hasSession } = buildRawArgs(args);
    const head = hasSession
      ? [positionals[0], command, ...positionals.slice(1)]
      : [command, ...positionals];
    argv = [...head, ...flags];
    passthrough = true;
  } else {
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

  server.registerTool('browser',
    {
      description:
        'Run an opencli browser primitive (navigate/click/type/snapshot/screenshot/get/...).\n' +
        'opencli browser <session> <command> [options] — session is a required positional, ' +
        'positional[] becomes subsequent CLI positionals (url/ref/key), args holds --flags.',
      inputSchema: {
        action: z.string().describe('Subcommand name, e.g. open / click / type / state / screenshot'),
        session: z.string().describe('Browser session name (required positional — pass the same name across calls to keep state alive)'),
        positional: z.union([
          z.array(z.union([z.string(), z.number()])),
          z.record(z.string(), z.unknown()),
          z.null(),
          // Claude Code MCP client serialises array fields as a single string
          // (e.g. `"['https://kimi.com/pricing']"` or `"https://kimi.com/pricing"`).
          // Accept bare strings here so the URL survives transit; handler splits
          // JSON-array strings below.
          z.string(),
        ]).optional()
          .describe('Additional CLI positionals after <command>, in order (e.g. [url] for open, [ref] for click, [key] for keys). Accepts an array (string|number), a record, a bare string, or null — some clients send null/empty/string when no positional is needed.'),
        args: z.record(z.string(), z.unknown()).optional().describe('Optional CLI flags as {key: value}; boolean true becomes bare --key'),
      },
    },
    async ({ action, session, positional, args }) => {
      // Normalize positional: may arrive as a (string|number)[] OR as a record
      // {0:..., 1:...} depending on the MCP client serialisation. Sort by
      // numeric key so [0,1,2] ordering survives. Stringify numbers since
      // CLI argv is always string.
      const posArr: string[] = Array.isArray(positional)
        ? positional.map((v) => String(v))
        : positional && typeof positional === 'object'
        ? Object.keys(positional)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => String((positional as Record<string, unknown>)[k]))
        : typeof positional === 'string' && positional
        ? // Claude Code MCP client serialises array fields as a JSON-string
          // (e.g. `"['https://kimi.com/pricing']"`) or as a plain string when
          // the array had one element. Try JSON.parse first; fall back to
          // wrapping the bare string as a single positional.
          (() => {
            try {
              const parsed = JSON.parse(positional);
              if (Array.isArray(parsed)) return parsed.map((v) => String(v));
              if (typeof parsed === 'string') return [parsed];
              return [positional];
            } catch {
              return [positional];
            }
          })()
        : [];
      // Some MCP clients (e.g. Claude Code) coerce array-typed schema fields
      // into a single string under `args.<fieldName>` rather than the top-
      // level array positional. Hoist any `args.positional` (string|string[])
      // into the positionals list so end-users don't have to fight the UI.
      const argsObj = { ...(args ?? {}) };
      if (argsObj.positional !== undefined) {
        const v = argsObj.positional;
        if (Array.isArray(v)) for (const p of v) posArr.push(String(p));
        else if (typeof v === 'string' && v) posArr.push(v);
        delete argsObj.positional;
      }
      const composed: Record<string, unknown> = { session, _: posArr, ...argsObj };
      return runCmd(deps, 'browser', action, composed, ctx.clientHost);
    });

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
