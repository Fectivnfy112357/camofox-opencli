import { describe, it, expect, vi } from 'vitest';
import { createRestHandler } from './rest.js';
import { loadManifest } from './manifest.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadManifest(join(here, '__fixtures__', 'manifest.sample.json'));
const cfg: Config = { port: 8080, apiKey: 'secret', opencliBin: 'opencli', manifestPath: '/x',
  camofoxUrl: 'http://h:9377', camofoxApiKey: null, camofoxUserId: 'u',
  publicVncHost: 'textvision.top' };

function mockRes() {
  return { statusCode: 0, body: '', headers: {} as Record<string,string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    writeHead(c: number) { this.statusCode = c; },
    end(b?: string) { this.body = b ?? ''; } };
}
function mockReq(method: string, url: string, auth?: string, body?: unknown) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return { method, url, headers: auth ? { authorization: auth } : {},
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } } as any;
}

const deps = { cfg, manifest,
  run: vi.fn(async () => ({ ok: true, data: { rows: [1] } })),
  vnc: vi.fn(async () => 'http://h:6080/vnc') };

describe('createRestHandler', () => {
  const h = createRestHandler(deps as any);

  it('GET /health needs no auth', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/health'), res as any);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('401 without bearer', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/sites'), res as any);
    expect(res.statusCode).toBe(401);
  });

  it('GET /sites returns all sites with valid key', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/sites', 'Bearer secret'), res as any);
    expect(res.statusCode).toBe(200);
    const env = JSON.parse(res.body);
    expect(env.ok).toBe(true);
    expect(env.data.length).toBe(2);
  });

  it('GET /sites/:site/help returns commands', async () => {
    const res = mockRes();
    await h(mockReq('GET', '/sites/bilibili/help', 'Bearer secret'), res as any);
    expect(JSON.parse(res.body).data.map((c: any) => c.name).sort()).toEqual(['comment', 'search']);
  });

  it('POST /run executes and returns data', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/run', 'Bearer secret',
      { site: 'bilibili', command: 'search', args: { keyword: 'x' } }), res as any);
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: { rows: [1] } });
  });

  it('POST /run 400 on unknown command', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/run', 'Bearer secret',
      { site: 'bilibili', command: 'nope', args: {} }), res as any);
    expect(res.statusCode).toBe(400);
  });

  it('POST /run passthrough site browser skips manifest', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/run', 'Bearer secret',
      { site: 'browser', command: 'navigate', args: { _: ['http://x'] } }), res as any);
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: { rows: [1] } });
    expect(deps.run).toHaveBeenLastCalledWith('browser', 'navigate', ['navigate', 'http://x'], { passthrough: true });
  });

  it('POST /run browser with session splices command between session and rest', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/run', 'Bearer secret',
      { site: 'browser', command: 'open', args: { session: 'work', _: ['https://x.com'] } }), res as any);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(deps.run).toHaveBeenLastCalledWith('browser', 'open', ['work', 'open', 'https://x.com'], { passthrough: true });
  });

  it('POST /run auto-returns vncUrl on AUTH_REQUIRED', async () => {
    const orig = deps.run;
    deps.run = vi.fn(async () => ({
      ok: false,
      data: {
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'login', help: 'Please log in to https://www.bilibili.com' },
        exitCode: 77,
      },
      stderr: '',
    }));
    try {
      const res = mockRes();
      await h(mockReq('POST', '/run', 'Bearer secret',
        { site: 'bilibili', command: 'search', args: { keyword: 'x' } }), res as any);
      const env = JSON.parse(res.body);
      expect(res.statusCode).toBe(200);
      expect(env.ok).toBe(true);
      expect(env.data.error.code).toBe('AUTH_REQUIRED');
      expect(env.data.vncUrl).toBe('http://h:6080/vnc');
      expect(deps.vnc).toHaveBeenCalledWith({ url: 'https://www.bilibili.com', clientHost: undefined });
    } finally {
      deps.run = orig;
    }
  });

  it('POST /run surfaces non-auth errors as 502', async () => {
    const orig = deps.run;
    deps.run = vi.fn(async () => ({ ok: false, stderr: 'something else broke' }));
    try {
      const res = mockRes();
      await h(mockReq('POST', '/run', 'Bearer secret',
        { site: 'bilibili', command: 'search', args: { keyword: 'x' } }), res as any);
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error.code).toBe('opencli_error');
    } finally {
      deps.run = orig;
    }
  });

  it('POST /run passes clientHost from X-Forwarded-Host to vnc', async () => {
    const orig = deps.run;
    deps.run = vi.fn(async () => ({
      ok: false,
      data: { ok: false, error: { code: 'AUTH_REQUIRED', help: 'go to https://x.com' }, exitCode: 77 },
      stderr: '',
    }));
    try {
      const res = mockRes();
      const req = mockReq('POST', '/run', 'Bearer secret', { site: 'bilibili', command: 'search', args: { keyword: 'x' } });
      (req.headers as any)['x-forwarded-host'] = 'people.example.com:443,proxy.example';
      await h(req, res as any);
      expect(deps.vnc).toHaveBeenCalledWith({ url: 'https://x.com', clientHost: 'people.example.com:443' });
    } finally {
      deps.run = orig;
    }
  });

  it('POST /login returns vncUrl', async () => {
    const res = mockRes();
    await h(mockReq('POST', '/login', 'Bearer secret', { url: 'http://site' }), res as any);
    expect(JSON.parse(res.body).data.vncUrl).toBe('http://h:6080/vnc');
  });
});
