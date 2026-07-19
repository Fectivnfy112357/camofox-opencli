import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { loadManifest } from './manifest.js';
import { runOpencli } from './opencli.js';
import { getVncUrl } from './camofox-login.js';
import { createRestHandler, type Deps } from './rest.js';
import { createMcpServer } from './mcp.js';
import { build as buildSearchCache, size as searchCacheSize } from './search-cache.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initLogger, log } from './logger.js';

initLogger(process.env);
const cfg = loadConfig(process.env);
const manifest = loadManifest(cfg.manifestPath);
buildSearchCache(manifest);
log.info('search_cache.ready', { sites: searchCacheSize() });

const deps: Deps = {
  cfg,
  manifest,
  run: (site, command, argv, opts) => runOpencli(cfg.opencliBin, site, command, argv, opts),
  vnc: (opts) => getVncUrl(cfg, opts),
};

const rest = createRestHandler(deps);

function headerHostOf(req: import('node:http').IncomingMessage): string | null {
  const xfHost = req.headers['x-forwarded-host'];
  return typeof xfHost === 'string' && xfHost
    ? xfHost.split(',')[0].trim()
    : (typeof req.headers.host === 'string' ? req.headers.host : null);
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/mcp') {
    // auth for MCP endpoint too
    if (cfg.apiKey && req.headers.authorization !== `Bearer ${cfg.apiKey}`) {
      log.warn('mcp.unauthorized', { host: headerHostOf(req) });
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad bearer' } }));
      return;
    }
    // Stateless mode: build a FRESH server + transport per request. Reusing a
    // single transport across concurrent requests crossed JSON-RPC streams and
    // caused intermittent failures → Claude Code's circuit breaker tripped.
    // The inbound Host is passed via a per-request ctx (no shared global), so
    // concurrent VNC-URL rewrites can't clobber each other.
    const ctx = { clientHost: headerHostOf(req) };
    const mcpServer = createMcpServer(deps, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcpServer.close(); });
    (async () => {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((e) => {
      log.error('mcp.error', { message: (e as Error).message });
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
    return;
  }
  rest(req, res).catch((e) => {
    log.error('rest.error', { message: (e as Error).message });
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});

server.listen(cfg.port, '0.0.0.0', () => {
  log.info('gateway.listen', { port: cfg.port, host: '0.0.0.0', sites: manifest.listSites().length });
  console.log(`[gateway] listening on 0.0.0.0:${cfg.port} (sites: ${manifest.listSites().length})`);
});
