import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import type { Manifest } from './manifest.js';
import { buildArgs, buildRawArgs, PASSTHROUGH_SITES, type RunResult } from './opencli.js';
import { log } from './logger.js';
import type { TempStore } from './video/temp-store.js';

export interface Deps {
  cfg: Config;
  manifest: Manifest;
  run: (site: string, command: string, argv: string[], opts?: { passthrough?: boolean }) => Promise<RunResult>;
  vnc: (opts: { url?: string; clientHost?: string }) => Promise<string>;
  tempStore?: TempStore;
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

/**
 * Best-effort extraction of the external hostname the client used. Tries
 * reverse-proxy headers first (X-Forwarded-Host, comma-separated), then
 * the raw Host header. Returns null when absent.
 */
function extractHost(req: IncomingMessage): string | null {
  const xf = req.headers['x-forwarded-host'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  const h = req.headers.host;
  return typeof h === 'string' && h ? h : null;
}

function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.m4a') return 'audio/mp4';
  return 'application/octet-stream';
}

export function createRestHandler(deps: Deps) {
  const { cfg, manifest } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') return ok(res, { status: 'up' });

    // Public file route (no auth, unguessable UUIDs). Must run BEFORE the
    // auth block so file downloads aren't blocked by GATEWAY_API_KEY.
    if (path.startsWith('/files/')) {
      if (method !== 'GET') return err(res, 405, 'method_not_allowed', 'only GET is supported on /files');
      if (!deps.tempStore) return err(res, 503, 'unavailable', 'temp store not configured');
      const idWithExt = path.slice('/files/'.length);
      const id = idWithExt.split('.')[0];
      const entry = deps.tempStore.get(id);
      if (!entry) return err(res, 404, 'not_found', 'file missing or expired');
      res.setHeader('Content-Type', mimeFor(entry.filename));
      res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
      res.setHeader('Content-Length', String(entry.size_bytes));
      res.writeHead(200);
      createReadStream(entry.path).pipe(res);
      return;
    }

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
        if (!site) return err(res, 400, 'bad_args', 'site is required');
        log.info('rest.run.start', { site, command, args });
        let argv: string[];
        let passthrough = false;
        if (PASSTHROUGH_SITES.has(site)) {
          // For browser: argv layout depends on whether the caller passed a session.
          //   with session: [session, command, ...rest-positionals, --flags]
          //   without session: [command, ...positionals, --flags]
          const { positionals, flags, hasSession } = buildRawArgs(args);
          const head = hasSession
            ? [positionals[0], command ?? '', ...positionals.slice(1)]
            : [command ?? '', ...positionals];
          argv = [...head, ...flags];
          passthrough = true;
        } else {
          const record = manifest.findCommand(site, command);
          if (!record) return err(res, 400, 'unknown_command', `no such command: ${site} ${command}`);
          // Mirror MCP /run_command: <site> login default timeout 30s.
          const augmentedArgs = (command === 'login' && args.timeout === undefined)
            ? { ...args, timeout: 30 }
            : args;
          try { argv = buildArgs(record, augmentedArgs); }
          catch (e) { return err(res, 400, 'bad_args', (e as Error).message); }
        }
        const r = await deps.run(site, command ?? '', argv, { passthrough });
        if (!r.ok) {
          const data = r.data as { error?: { code?: string; help?: string } } | undefined;
          if (data?.error?.code === 'AUTH_REQUIRED') {
            const url = data.error.help?.match(/https?:\/\/\S+/)?.[0];
            const vncUrl = await deps.vnc({ url, clientHost: extractHost(req) ?? undefined });
            log.warn('rest.run.auth_required', { site, command, vncUrl });
            return ok(res, { error: data.error, vncUrl, hint: 'Open the VNC link, log in, then re-run /run.' });
          }
          log.warn('rest.run.error', { site, command, stderr: r.stderr });
          return err(res, 502, 'opencli_error', r.stderr ?? 'unknown');
        }
        log.info('rest.run.done', { site, command, ok: true });
        return ok(res, r.data);
      }
      if (method === 'POST' && path === '/login') {
        const b = await readBody(req);
        const vncUrl = await deps.vnc({ url: b.url, clientHost: extractHost(req) ?? undefined });
        return ok(res, { vncUrl });
      }
      return err(res, 404, 'not_found', `no route: ${method} ${path}`);
    } catch (e) {
      return err(res, 500, 'internal', (e as Error).message);
    }
  };
}
