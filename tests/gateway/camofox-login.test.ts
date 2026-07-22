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
  it('returns first-toggle vncUrl when present (no opts.url)', async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://127.0.0.1:6080/vnc.html?t=first' });
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'textvision.top' }, fake as any);
    expect(out).toBe('http://textvision.top:6080/vnc.html?t=first');
    // No cycle when first succeeds — exactly one toggle call
    expect(calls.filter((c) => c.endsWith('/toggle-display'))).toHaveLength(1);
    // No create-tab call when opts.url is absent
    expect(calls.some((c) => c.startsWith('POST /tabs'))).toBe(false);
  });

  it('creates a tab when none exist, then toggles', async () => {
    const fake = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'GET' && url.includes('/tabs?')) return json([]);
      if (init?.method === 'POST' && url.endsWith('/tabs')) return json({ tabId: 'created' });
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/x' });
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'textvision.top' }, fake as any);
    expect(out).toBe('http://textvision.top:6080/x');
  });

  it('cycles headful→virtual on empty first toggle, returns second', async () => {
    let toggleCount = 0;
    const fake = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) {
        toggleCount++;
        if (toggleCount === 1) return json({}); // first toggle empty
        return json({ vncUrl: 'http://localhost:6080/vnc.html?t=cycled' });
      }
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'textvision.top' }, fake as any);
    expect(out).toBe('http://textvision.top:6080/vnc.html?t=cycled');
    expect(toggleCount).toBeGreaterThanOrEqual(2);
  });

  it('retries up to 3 times then throws if no vncUrl', async () => {
    const toggleCalls: string[] = [];
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) {
        toggleCalls.push(url);
        return json({}); // always empty
      }
      return json({});
    });
    await expect(
      getVncUrl(cfg, { clientHost: 'textvision.top' }, fake as any),
    ).rejects.toThrow(/vncUrl/);
    // 1 initial + 1 headless=false + 3 virtual retries = 5 toggles
    expect(toggleCalls.length).toBe(5);
  });

  it('navigates opts.url after obtaining vncUrl (skill order)', async () => {
    const order: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      order.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/v' });
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
    expect(out).toBe('http://textvision.top:6080/v');
    // toggle must come before create-tab; create-tab before navigate
    const toggleIdx = order.findIndex((c) => c.endsWith('/toggle-display'));
    const createIdx = order.findIndex((c) => c === `POST ${cfg.camofoxUrl}/tabs`);
    const navIdx = order.findIndex((c) => c.includes('/tabs/navtab/navigate'));
    expect(toggleIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(toggleIdx);
    expect(navIdx).toBeGreaterThan(createIdx);
  });

  it('uses opts.clientHost for rewriting when provided', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://127.0.0.1:6080/vnc.html?x=1' });
      return json({});
    });
    const out = await getVncUrl(cfg, { clientHost: 'people.example.com:443' }, fake as any);
    expect(out).toBe('http://people.example.com:6080/vnc.html?x=1');
  });

  it('falls back to PUBLIC_VNC_HOST when clientHost absent (per-instance config)', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/v' });
      return json({});
    });
    const cfgNoClient: Config = { ...cfg, publicVncHost: 'static.example.com' };
    const out = await getVncUrl(cfgNoClient, {}, fake as any);
    expect(out).toBe('http://static.example.com:6080/v');
  });

  it('throws if neither clientHost nor PUBLIC_VNC_HOST is set — no silent localhost leak', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/v' });
      return json({});
    });
    const cfgDefault: Config = { ...cfg, publicVncHost: null };
    await expect(getVncUrl(cfgDefault, {}, fake as any)).rejects.toThrow(
      /PUBLIC_VNC_HOST|Host header/,
    );
  });
});
