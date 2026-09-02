import type { Config } from '../core/config.js';

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
 * Ensure at least one tab exists for the userId. The VNC page is mostly
 * useful once a real page is loaded — open a blank tab if none exist so
 * the noVNC viewer has something to display.
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

/**
 * Compute the noVNC URL for the Camofox browser. The upstream is
 * jo-inc/camofox-browser, which has no runtime toggle-display endpoint
 * (the previous redf0x1 fork had one). Instead, noVNC is started at boot
 * via CAMOFOX_INTERACTIVE=novnc, and the noVNC web client is served on
 * port 6080 by supervisord-managed websockify. The URL is therefore
 * deterministic: <host>:<6080>/vnc.html.
 */
function buildVncUrl(cfg: Config): string {
  const u = new URL(cfg.camofoxUrl);
  u.port = '6080';
  u.pathname = '/vnc.html';
  return u.toString();
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
 *   1. ensure_tabs        — open a tab if none exist so the VNC viewer
 *                           has something to display
 *   2. derive vnc URL     — jo-inc has no toggle-display; the URL is
 *                           <host>:6080/vnc.html (set up at boot via
 *                           CAMOFOX_INTERACTIVE=novnc)
 *   3. create_tab+navigate — when opts.url is set, opens the page so the
 *                           user lands directly on the auth flow
 *   4. rewrite host       — swap localhost/127.0.0.1 for the public host
 *
 * Throws if no external VNC host can be determined.
 */
export async function getVncUrl(
  cfg: Config,
  opts: { url?: string; clientHost?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  await ensureTab(cfg, fetchImpl);

  // If a target URL is given, open a tab navigated to it BEFORE we hand
  // the noVNC URL back. The previous toggle-display flow invalidated
  // existing tabs on demand; with jo-inc we keep tabs alive and instead
  // rely on the operator (or the caller) to have the desired page open
  // when the operator clicks the VNC link.
  if (opts.url) {
    await createNavTab(cfg, fetchImpl, opts.url);
  }

  const vnc = buildVncUrl(cfg);

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
