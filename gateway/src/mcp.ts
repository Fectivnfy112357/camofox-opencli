import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import { execFile as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Deps } from './rest.js';
import type { Manifest } from './manifest.js';
import { buildArgs, PASSTHROUGH_SITES, type RunResult } from './opencli.js';
import { log } from './logger.js';
import * as searchCache from './search-cache.js';
import { searchVideos, type RouterDeps } from './video/video-router.js';
import { DownloadPool, type RunResultLike } from './video/download-pool.js';
import { TempStore } from './video/temp-store.js';
import { buildAbsoluteUrl } from './video/url-builder.js';
import type { CamofoxCookie } from './video/video-cookies.js';

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
 * concurrent requests can't clobber each other's host. `req` is forwarded
 * for video_download to build absolute download URLs from X-Forwarded-* headers.
 */
export interface ServerCtx { clientHost: string | null; req?: IncomingMessage }

/** Lazy video subsystem built once per server (deps.tempStore is shared). */
interface VideoSubsystem {
  pool: DownloadPool;
  fetchCookies: (userId: string) => Promise<CamofoxCookie[]>;
}

let _video: VideoSubsystem | null = null;

function getVideoSubsystem(deps: Deps): VideoSubsystem {
  if (_video) return _video;
  const tmpDir = deps.tempStore?.['opts']?.tmpDir ?? process.env.GATEWAY_TMP_DIR ?? './tmp';
  const execAsync = promisify(execCb) as unknown as (
    cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  const tempStore = deps.tempStore ?? new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
  const camofoxBase = process.env.CAMOFOX_BASE_URL ?? 'http://127.0.0.1:9377';
  const camofoxKey = process.env.CAMOFOX_API_KEY ?? '';
  const userId = process.env.CAMOFOX_USER_ID ?? 'default';

  const fetchCookies = async (uid: string): Promise<CamofoxCookie[]> => {
    const url = `${camofoxBase}/sessions/${encodeURIComponent(uid)}/cookies`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (camofoxKey) headers['Authorization'] = `Bearer ${camofoxKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Camofox cookies HTTP ${res.status}`);
    return (await res.json()) as CamofoxCookie[];
  };

  const pool = new DownloadPool({
    tmpDir,
    tempStore,
    workerCount: 3,
    runOpencli: async (site, command, argv) => {
      const r = await deps.run(site, command, argv);
      const ok = !!r.ok;
      const stdout = ok ? JSON.stringify(r.data ?? {}) : '';
      const stderr = ok ? '' : (r.stderr ?? JSON.stringify(r.data ?? {}));
      return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
    },
    fetchCamofoxCookies: fetchCookies,
    exec: async (cmd, args, opts) => {
      try {
        const { stdout, stderr } = await execAsync(cmd, args, opts ?? {});
        return { ok: true, exitCode: 0, stdout, stderr };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return { ok: false, exitCode: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
      }
    },
  });

  _video = { pool, fetchCookies };
  return _video;
}

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

  // video_search: cross-platform search fan-out (3 concurrent sites).
  // Supported platform values: bilibili, youtube, douyin, tiktok, instagram,
  // xiaohongshu, weibo, twitter, "all" (all 8), or omit (default 3).
  const video = getVideoSubsystem(deps);
  server.registerTool('video_search',
    {
      description: 'Search videos across supported platforms. Default platforms (when platform is omitted): bilibili, youtube, douyin. Pass platform="all" to search all 8 supported sites (bilibili, youtube, douyin, tiktok, instagram, xiaohongshu, weibo, twitter). Up to 3 sites are queried in parallel; per-site failures are returned in stats.failed without aborting the whole request.',
      inputSchema: {
        query: z.string().min(1).describe('Search keywords (non-empty)'),
        platform: z.string().optional().describe('Site name (bilibili|youtube|douyin|tiktok|instagram|xiaohongshu|weibo|twitter), "all", or omit for the default 3 sites'),
        limit: z.number().int().min(1).max(30).optional().describe('Results per site (default 10)'),
      },
    },
    async ({ query, platform, limit }) => {
      log.info('video.search.start', { query, platform, limit: limit ?? null });
      try {
        const routerDeps: RouterDeps = {
          runOpencli: async (site, command, argv) => {
            const r = await deps.run(site, command, argv);
            const ok = !!r.ok;
            return {
              ok,
              exitCode: ok ? 0 : 1,
              stdout: ok ? JSON.stringify(r.data ?? {}) : '',
              stderr: ok ? '' : (r.stderr ?? JSON.stringify(r.data ?? {})),
            };
          },
        };
        const res = await searchVideos({ query, platform, limit }, routerDeps);
        log.info('video.search.done', {
          query, platform: platform ?? null,
          results: res.results.length,
          ok: res.stats.succeeded.length,
          failed: res.stats.failed.length,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      } catch (err) {
        const code = (err as { code?: string })?.code ?? 'EMPTY_QUERY';
        log.warn('video.search.error', { query, platform: platform ?? null, code, message: (err as Error).message });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: (err as Error).message } }) }] };
      }
    },
  );

  // video_download: download 1-3 URLs to a temp file inside the container.
  // Returns a temporary HTTPS URL the client can GET to fetch the bytes
  // (1-hour TTL, see GET /files/:id route). Bilibili and Instagram route
  // through opencli's native download; every other platform falls back to
  // yt-dlp with Camofox cookies injected.
  server.registerTool('video_download',
    {
      description: 'Download 1-3 video URLs to a temp file inside the container. Returns a temporary HTTPS URL the client can GET to fetch the bytes. Files are deleted after 1 hour. Bilibili and Instagram use OpenCLI native download; all other platforms use yt-dlp with Camofox cookies injected automatically.',
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(3).describe('1-3 video URLs to download in parallel'),
        quality: z.enum(['best', '1080p', '720p', '480p', 'worst']).optional().describe('Video quality (default best)'),
      },
    },
    async ({ urls, quality }) => {
      const q = quality ?? 'best';
      log.info('video.download.start', { urls: urls.map((u) => new URL(u).hostname), quality: q });
      const t0 = Date.now();
      const results = await video.pool.downloadMany(urls, q);
      const req: IncomingMessage = ctx.req ?? ({ headers: {} } as IncomingMessage);
      const patched = results.map((r, i) => {
        if (!r.ok) return r;
        const abs = buildAbsoluteUrl(req, r.download_url);
        return { ...r, url: urls[i], download_url: abs ?? r.download_url };
      });
      log.info('video.download.done', {
        urls: urls.map((u) => new URL(u).hostname),
        quality: q,
        ms: Date.now() - t0,
        ok_count: patched.filter((r) => r.ok).length,
        fail_count: patched.length - patched.filter((r) => r.ok).length,
        methods: patched.filter((r) => r.ok).map((r) => (r as { method?: string }).method ?? '?'),
        errors: patched.filter((r) => !r.ok).map((r) => (r as { error_code?: string }).error_code ?? '?'),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ results: patched }) }] };
    },
  );

  for (const site of PRIMARY_SITES) {
    server.registerTool(`${site}_command`,
      { description: buildSiteToolDescription(deps.manifest, site), inputSchema: { command: z.string(), args: z.record(z.string(), z.unknown()).optional() } },
      async ({ command, args }) => runCmd(deps, site, command, args ?? {}, ctx.clientHost));
  }

  return server;
}
