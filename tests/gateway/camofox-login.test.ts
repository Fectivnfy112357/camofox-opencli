import { describe, it, expect, vi } from 'vitest';
import { rewriteVncHost, getVncUrl } from '../../src/gateway/mcp/camofox-login.js';
import type { Config } from '../../src/gateway/core/config.js';

const cfg: Config = {
  port: 8080, apiKey: null, opencliBin: 'opencli', manifestPath: '/x',
  camofoxUrl: 'http://textvision.top:9377', camofoxApiKey: 'k', camofoxUserId: 'u',
  publicVncHost: 'textvision.top',
  tmpDir: '/tmp', logDir: '/tmp', logLevel: 'info',
  cookieDir: '/tmp', outputDir: '/tmp',
  proxyUrl: null,
};

function json(body: unknown) {
  return { ok: true, json: async () => body } as any;
}

describe('rewriteVncHost', () => {
  it('replaces localhost with remote host, forces port 6080', () => {
    expect(rewriteVncHost('http://localhost:6080/vnc.html?token=abc', 'textvision.top'))
      .toBe('http://textvision.top:6080/vnc.html?token=abc');
  });

  it('strips port from externalHost — VNC port is always 6080', () => {
    expect(rewriteVncHost('http://localhost:6080/vnc.html?token=abc', 'camofox.example.com:9378'))
      .toBe('http://camofox.example.com:6080/vnc.html?token=abc');
  });
});

describe('getVncUrl', () => {
  // Upstream is now jo-inc/camofox-browser, which has no runtime
  // /sessions/:userId/toggle-display endpoint. VNC is started at boot
  // via CAMOFOX_INTERACTIVE=novnc, and the noVNC web client lives on
  // port 6080 — so the URL is just <camofoxUrl-host>:6080/vnc.html.
  // The gateway only has to (a) ensure a tab exists, (b) optionally
  // navigate to opts.url, and (c) rewrite the host for the public view.

  it('returns the deterministic noVNC URL when a tab already exists (no opts.url)', async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'textvision.top' }, fake as any);
    // Derived from cfg.camofoxUrl, not from any server response.
    expect(out).toBe('http://textvision.top:6080/vnc.html');
    // Only a single ensure-tab GET; no toggle-display or POST /tabs.
    expect(calls).toEqual([`GET ${cfg.camofoxUrl}/tabs?userId=u`]);
  });

  it('creates a tab when none exist, then derives the URL', async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'GET' && url.includes('/tabs?')) return json([]);
      if (init?.method === 'POST' && url.endsWith('/tabs')) return json({ tabId: 'created' });
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'textvision.top' }, fake as any);
    expect(out).toBe('http://textvision.top:6080/vnc.html');
    expect(calls).toEqual([
      `GET ${cfg.camofoxUrl}/tabs?userId=u`,
      `POST ${cfg.camofoxUrl}/tabs`,
    ]);
  });

  it('navigates opts.url to a new tab BEFORE returning the URL (skill order)', async () => {
    const order: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      order.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (init?.method === 'POST' && url.endsWith('/tabs') && url === `${cfg.camofoxUrl}/tabs`) {
        return json({ tabId: 'navtab' });
      }
      if (url.includes('/tabs/navtab/navigate')) return json({ ok: true });
      return json({});
    });
    const out = await getVncUrl(
      cfg,
      { url: 'https://www.zhihu.com', clientHost: 'textvision.top' },
      fake as any,
    );
    expect(out).toBe('http://textvision.top:6080/vnc.html');
    // ensure-tab → create-nav-tab → navigate. No toggle-display in the new flow.
    const ensureIdx = order.findIndex((c) => c === `GET ${cfg.camofoxUrl}/tabs?userId=u`);
    const createIdx = order.findIndex((c) => c === `POST ${cfg.camofoxUrl}/tabs`);
    const navIdx = order.findIndex((c) => c.includes('/tabs/navtab/navigate'));
    expect(ensureIdx).toBe(0);
    expect(createIdx).toBeGreaterThan(ensureIdx);
    expect(navIdx).toBeGreaterThan(createIdx);
    expect(order.some((c) => c.includes('toggle-display'))).toBe(false);
  });

  it('uses opts.clientHost for rewriting when provided', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'people.example.com:443' }, fake as any);
    expect(out).toBe('http://people.example.com:6080/vnc.html');
  });

  it('falls back to PUBLIC_VNC_HOST when clientHost absent (per-instance config)', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      return json({});
    });
    const cfgNoClient: Config = { ...cfg, publicVncHost: 'static.example.com' };
    const out = await getVncUrl(cfgNoClient, {}, fake as any);
    expect(out).toBe('http://static.example.com:6080/vnc.html');
  });

  it('throws if neither clientHost nor PUBLIC_VNC_HOST is set — no silent localhost leak', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      return json({});
    });
    const cfgDefault: Config = { ...cfg, publicVncHost: null };
    await expect(getVncUrl(cfgDefault, {}, fake as any)).rejects.toThrow(
      /PUBLIC_VNC_HOST|Host header/,
    );
  });
});
