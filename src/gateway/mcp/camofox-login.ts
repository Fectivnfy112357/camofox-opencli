import type { Config } from '../core/config.js';

const TOGGLE_RETRIES = 3;

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.camofoxApiKey) h.Authorization = `Bearer ${cfg.camofoxApiKey}`;
  return h;
}

/**
 * Replace the hostname in a Camofox-issued VNC URL with the external host
 * the operator wants clients to use. Strips any port from the external host
 * (VNC always serves on 6080 unless overridden via env).
 */
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

/**
 * Ensure at least one tab exists for the userId. The Camofox fork only
 * returns a vncUrl on toggle-display when existing tabs are invalidated
 * (see camofox-browser toggle-display handler); without any tab the toggle
 * does nothing visible.
 */
async function ensureTab(cfg: Config, f: typeof fetch): Promise<void> {
  try {
    const res = await f(`${cfg.camofoxUrl}/tabs?userId=${encodeURIComponent(cfg.camofoxUserId)}`,
      { headers: headers(cfg) });
    const body = await res.json().catch(() => ({})) as any;
    const list = Array.isArray(body) ? body : body.tabs ?? [];
    if (list.length > 0) return;
  } catch { /* proceed optimistically */ }
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
  return typeof body?.vncUrl === 'string' ? body.vncUrl : '';
}

/**
 * Open a fresh tab and navigate it to opts.url. Matches the skill's
 * create_tab + navigate_tab step — used when the caller passes a target URL
 * so the user lands directly on the login page when they open the VNC link.
 */
async function createNavTab(cfg: Config, f: typeof fetch, targetUrl: string): Promise<void> {
  const tabRes = await f(`${cfg.camofoxUrl}/tabs`, {
    method: 'POST', headers: headers(cfg),
    body: JSON.stringify({ userId: cfg.camofoxUserId, sessionKey: `vnc_nav_${cfg.camofoxUserId}` }),
  });
  const tab = await tabRes.json().catch(() => ({})) as any;
  const tabId = tab?.tabId ?? tab?.id;
  if (!tabId) return;
  await f(`${cfg.camofoxUrl}/tabs/${tabId}/navigate`, {
    method: 'POST', headers: headers(cfg),
    body: JSON.stringify({ userId: cfg.camofoxUserId, url: targetUrl }),
  });
}

/**
 * Get a noVNC URL for manual login.
 *
 * Mirrors browser-auth-recovery/scripts/camofox-vnc-login.py:
 *   1. ensure_tabs         — toggle-display only yields vncUrl with a real tab
 *   2. toggle virtual      — first attempt to obtain vncUrl
 *   3. cycle false→virtual — if (2) yields nothing (VNC already active, no
 *                            tab was invalidated), force a fresh server by
 *                            toggling headful then virtual, up to 3 retries
 *   4. create_tab+navigate — when opts.url is set, opens the page so the
 *                            user lands directly on the auth flow
 *   5. rewrite host        — swap localhost/127.0.0.1 for the public host
 *
 * Throws if no vncUrl can be obtained within the retry budget.
 */
export async function getVncUrl(
  cfg: Config,
  opts: { url?: string; clientHost?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  await ensureTab(cfg, fetchImpl);

  // First attempt — toggling to virtual (the supported mode).
  let vnc = await toggle(cfg, fetchImpl, 'virtual');

  if (!vnc) {
    // No vncUrl returned — VNC may already be active or tab wasn't
    // invalidated. Cycle headful→virtual to force a fresh VNC server, per
    // browser-auth-recovery skill.
    try {
      await toggle(cfg, fetchImpl, false); // may 400 if already headful
    } catch { /* tolerated */ }
    for (let i = 0; i < TOGGLE_RETRIES && !vnc; i++) {
      vnc = await toggle(cfg, fetchImpl, 'virtual').catch(() => '');
    }
  }

  if (!vnc) {
    throw new Error('could not obtain vncUrl after retries');
  }

  // The skill navigates to opts.url after extracting vncUrl. Doing it in
  // this order means tab invalidation from toggle has settled before we
  // open a new tab.
  if (opts.url) {
    await createNavTab(cfg, fetchImpl, opts.url);
  }

  const clientHost = opts.clientHost?.split(':')[0]?.trim();
  const configuredHost = cfg.publicVncHost?.split(':')[0]?.trim();
  const externalHost = clientHost || configuredHost;
  if (!externalHost) {
    // No client Host header (e.g. unix socket) AND no operator override.
    // Refuse to silently default to localhost — every install points the MCP
    // server at a different external host (textvision.top, my-tunnel.ngrok.io,
    // host.docker.internal, etc.), so the only safe behaviour is to fail
    // loudly and let the caller set PUBLIC_VNC_HOST or send a Host header.
    throw new Error(
      'cannot determine external VNC host: pass PUBLIC_VNC_HOST env var or send an X-Forwarded-Host / Host header',
    );
  }
  return rewriteVncHost(vnc, externalHost);
}
