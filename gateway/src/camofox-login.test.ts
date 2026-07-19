import { describe, it, expect, vi } from 'vitest';
import { rewriteVncHost, getVncUrl } from './camofox-login.js';
import type { Config } from './config.js';

const cfg: Config = {
  port: 8080, apiKey: null, opencliBin: 'opencli', manifestPath: '/x',
  camofoxUrl: 'http://textvision.top:9377', camofoxApiKey: 'k', camofoxUserId: 'u',
  publicVncHost: 'textvision.top',
};

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
  it('ensures tab then returns rewritten vncUrl from first toggle', async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tabs?')) return json([{ tabId: 't1' }]);
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/vnc.html?t=1' });
      return json({});
    });
    const out = await getVncUrl(cfg, {}, fake as any);
    expect(out).toBe('http://textvision.top:6080/vnc.html?t=1');
    expect(calls.some((c) => c.includes('/tabs?'))).toBe(true);
  });

  it('creates a tab when none exist', async () => {
    const fake = vi.fn(async (url: string) => {
      if (url.includes('/tabs?')) return json([]);
      if (url.endsWith('/tabs')) return json({ tabId: 'new' });
      if (url.endsWith('/toggle-display')) return json({ vncUrl: 'http://localhost:6080/x' });
      return json({});
    });
    const out = await getVncUrl(cfg, {}, fake as any);
    expect(out).toContain('textvision.top');
  });
});

function json(body: unknown) {
  return { ok: true, json: async () => body } as any;
}
