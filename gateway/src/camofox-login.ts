import type { Config } from './config.js';

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.camofoxApiKey) h.Authorization = `Bearer ${cfg.camofoxApiKey}`;
  return h;
}

export function rewriteVncHost(vncUrl: string, externalHost: string): string {
  const v = new URL(vncUrl);
  // externalHost may be `host` or `host:port` (or `host:port:extra`,
  // tolerated). Strip port — VNC always serves on the standard 6080 unless
  // the operator overrides via env.
  const host = externalHost.split(':')[0];
  v.hostname = host;
  v.port = '6080';
  return v.toString();
}

async function ensureTab(cfg: Config, f: typeof fetch): Promise<void> {
  try {
    const res = await f(`${cfg.camofoxUrl}/tabs?userId=${encodeURIComponent(cfg.camofoxUserId)}`,
      { headers: headers(cfg) });
    const body = await res.json() as any;
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
  const body = await res.json().catch(() => ({})) as any;
  return body.vncUrl ?? '';
}

export async function getVncUrl(
  cfg: Config,
  opts: { url?: string; clientHost?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  await ensureTab(cfg, fetchImpl);
  // Camofox fork exposes a noVNC server (port 6080) that's always on while
  // the container is alive — there is no toggle-display endpoint to flip
  // headless mode on demand (the upstream-camofox version had it; the fork
  // dropped it). Build the noVNC URL directly against the configured host.
  const camofoxUrl = cfg.camofoxUrl; // e.g. http://localhost:9377
  const host = opts.clientHost?.split(':')[0] || new URL(camofoxUrl).hostname;
  const scheme = new URL(camofoxUrl).protocol.replace(':', '');
  const vnc = `${scheme}://${host}:6080/vnc.html?autoconnect=true&resize=scale`;
  if (opts.url) {
    const res = await fetchImpl(`${cfg.camofoxUrl}/tabs`, {
      method: 'POST', headers: headers(cfg),
      body: JSON.stringify({ userId: cfg.camofoxUserId, sessionKey: `vnc_nav_${cfg.camofoxUserId}` }),
    });
    const tab = await res.json() as any;
    const tabId = tab.tabId ?? tab.id;
    if (tabId) {
      await fetchImpl(`${cfg.camofoxUrl}/tabs/${tabId}/navigate`, {
        method: 'POST', headers: headers(cfg),
        body: JSON.stringify({ userId: cfg.camofoxUserId, url: opts.url }),
      });
    }
  }
  const externalHost = opts.clientHost || cfg.publicVncHost || new URL(cfg.camofoxUrl).hostname;
  return rewriteVncHost(vnc, externalHost);
}
