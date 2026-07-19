/**
 * dev-mock.ts — local development entry that starts the same MCP server as
 * `index.ts` but replaces `deps.run` with a logger. Lets you exercise the
 * full MCP request → schema-validate → argv-build path end-to-end without
 * spawning opencli, so you can iterate on schema/argv shape in seconds:
 *
 *   npm run dev:mock
 *
 * The mock prints the spawn argv, the passthrough flag, and returns a fake
 * `ok:true` result so the MCP client gets a normal success response. Switch
 * the MCP URL in `.claude.json` to `http://localhost:8080/mcp` to point the
 * Claude Code MCP client at this dev process.
 */
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { loadManifest } from './manifest.js';
import { getVncUrl } from './camofox-login.js';
import { createRestHandler, type Deps } from './rest.js';
import { createMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RunResult } from './opencli.js';
import { initLogger } from './logger.js';

initLogger(process.env);

const cfg = loadConfig(process.env);
// dev:mock defaults to no-auth unless GATEWAY_API_KEY is explicitly set AND
// DEV_MOCK_AUTH is truthy — keeps the Claude Code MCP client config minimal.
if (!process.env.DEV_MOCK_AUTH) cfg.apiKey = null;
// Manifest path may not exist locally; fall back to a minimal stub so the
// gateway still boots. Manifest-driven tools (run_command, <site>_command)
// will 400 on unknown sites, but browser/doctor/list_sites/site_help/login
// all work without manifest data.
let manifest;
try {
  manifest = loadManifest(cfg.manifestPath);
} catch (e) {
  console.warn(`[dev-mock] manifest load failed: ${(e as Error).message}`);
  console.warn('[dev-mock] using empty manifest — only browser/doctor/list_sites/login work');
  manifest = new (await import('./manifest.js')).Manifest([]);
}

const mockRun = async (
  site: string,
  command: string,
  argv: string[],
  opts?: { passthrough?: boolean },
): Promise<RunResult> => {
  // Mirror the filter in runOpencli() to drop empty parts — otherwise doctor
  // (which sends command="" with no positional) would print `opencli doctor ""`.
  const raw = opts?.passthrough ? [site, ...argv] : [site, command, ...argv];
  const parts = raw.filter((p) => p !== '' && p != null);
  const cmdline = `opencli ${parts.join(' ')}`;
  console.log(`[mock-run] ${cmdline}`);
  return {
    ok: true,
    data: { mock: true, site, command, argv, passthrough: !!opts?.passthrough, cmdline },
  };
};

const deps: Deps = {
  cfg,
  manifest,
  run: mockRun,
  vnc: async () => 'http://localhost:6080/vnc.html',
};

const rest = createRestHandler(deps);

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/mcp') {
    // No auth in dev mode — keeps MCP client config minimal.
    const xfHost = req.headers['x-forwarded-host'];
    const headerHost = typeof xfHost === 'string' && xfHost
      ? xfHost.split(',')[0].trim()
      : (typeof req.headers.host === 'string' ? req.headers.host : null);
    // Fresh server+transport per request (mirrors index.ts stateless mode).
    const mcpServer = createMcpServer(deps, { clientHost: headerHost });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcpServer.close(); });
    (async () => {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((e) => {
      console.error('[dev-mock] mcp error', e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
    return;
  }
  rest(req, res).catch((e) => {
    console.error('[dev-mock] rest error', e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`[dev-mock] listening on http://localhost:${cfg.port}/mcp`);
  console.log(`[dev-mock] deps.run is mocked — argv printed to stdout instead of spawning opencli`);
  console.log(`[dev-mock] auth: disabled (GATEWAY_API_KEY=${cfg.apiKey ?? '<none>'})`);
});
