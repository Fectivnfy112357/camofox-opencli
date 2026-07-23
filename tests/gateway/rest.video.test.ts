import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRestHandler } from '../../src/gateway/api/rest.js';
import { runVideoSearch, runVideoDownload, type VideoHandlerCtx } from '../../src/gateway/video/video-handlers.js';
import type { Deps } from '../../src/gateway/api/rest.js';
import type { Manifest } from '../../src/gateway/core/manifest.js';
import type { Config } from '../../src/gateway/core/config.js';
import type { VideoSubsystem } from '../../src/gateway/mcp/mcp.js';
import { TempStore } from '../../src/gateway/video/temp-store.js';

function makeManifest(): Manifest {
  return {
    getSiteHelp: vi.fn().mockReturnValue([]),
    listSites: vi.fn().mockReturnValue([]),
    searchSites: vi.fn().mockReturnValue([]),
  } as unknown as Manifest;
}

function makeCfg(tmpDir: string, apiKey = 'test-key'): Config {
  return {
    apiKey,
    manifestPath: '/tmp/m.json',
    tmpDir,
    logDir: '/tmp',
    logLevel: 'info',
    cookieDir: '/tmp',
    outputDir: '/tmp',
    proxyUrl: null,
  };
}

interface ResSpy {
  res: any;
  status: number;
  body: any;
  writeHead: (s: number) => void;
  setHeader: (k: string, v: string) => void;
  end: (b: string) => void;
}

function makeRes(): ResSpy {
  const spy: ResSpy = {
    res: undefined as any,
    status: 0,
    body: undefined,
    writeHead: function (s: number) { this.status = s; },
    setHeader: function (_k: string, _v: string) { /* no-op */ },
    end: function (b: string) { this.body = b ? JSON.parse(b) : undefined; },
  };
  spy.res = spy;
  return spy;
}

function makeReq(opts: { method: string; url: string; body?: any; headers?: Record<string, string> }): import('node:http').IncomingMessage {
  const raw = opts.body !== undefined ? JSON.stringify(opts.body) : '';
  const r: any = {
    method: opts.method,
    url: opts.url,
    headers: Object.assign({ host: 'gateway.local' }, opts.headers || {}),
  };
  r[Symbol.asyncIterator] = async function* () { if (raw) yield raw; };
  return r as import('node:http').IncomingMessage;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rest-video-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

describe('REST /video/* auth + happy path', () => {
  let video: VideoSubsystem;
  let deps: Deps;
  let handler: ReturnType<typeof createRestHandler>;

  beforeEach(async () => {
    await withTmpDir(async (tmpDir) => {
      video = {
        pool: { downloadMany: vi.fn() } as unknown as VideoSubsystem['pool'],
        fetchCookies: vi.fn(),
      };
      deps = {
        cfg: makeCfg(tmpDir, 'test-key'),
        manifest: makeManifest(),
        run: vi.fn(),
        vnc: vi.fn(),
        tempStore: new TempStore({ tmpDir, ttlMs: 60_000 }),
      };
      handler = createRestHandler(deps, {
        search: runVideoSearch,
        download: runVideoDownload,
        subsystem: video,
      });
    });
  });

  it('rejects unauthenticated POST /video/search with 401', async () => {
    const req = makeReq({ method: 'POST', url: '/video/search', body: { query: 'x' } });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('search returns 200 with results + stats', async () => {
    deps.run = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ id: 'BV1', title: 't', url: 'https://www.bilibili.com/video/BV1' }],
    });
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: 'x' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data.results)).toBe(true);
    expect(Array.isArray(res.body.data.stats.succeeded)).toBe(true);
  });

  it('search 400 bad_args on empty query (REST validates before reaching router)', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: '' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('search 400 INVALID_PLATFORM on bogus platform', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: 'x', platform: 'bogus' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PLATFORM');
  });

  it('search 400 bad_args when query missing', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: {},
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('download returns 200 with patched absolute download_url', async () => {
    (video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        url: 'https://x/y',
        ok: true,
        method: 'ytdlp',
        filename: 'video_abc.mp4',
        size_bytes: 1024,
        download_url: '/files/abc.mp4',
        expires_at: '2099-01-01T00:00:00Z',
      },
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://x/y'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].download_url).toMatch(/^http:\/\/gateway\.local\/files\/abc\.mp4$/);
  });

  it('download 400 bad_args on urls missing', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: {},
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('download 400 bad_args on urls > 3', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_args');
  });

  it('download propagates per-URL failure as results[].ok=false', async () => {
    (video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        url: 'https://x/y',
        ok: false,
        error_code: 'LOGIN_REQUIRED',
        error_message: 'sign in to confirm you are not a bot',
      },
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://x/y'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].ok).toBe(false);
    expect(res.body.data.results[0].error_code).toBe('LOGIN_REQUIRED');
  });

  it('download 500 internal on pool throw', async () => {
    (video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const req = makeReq({
      method: 'POST',
      url: '/video/download',
      body: { urls: ['https://x/y'] },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
  });

  it('search returns 200 with per-site failures in stats.failed when deps.run rejects', async () => {
    deps.run = vi.fn().mockRejectedValue(new Error('kaboom'));
    const req = makeReq({
      method: 'POST',
      url: '/video/search',
      body: { query: 'x' },
      headers: { authorization: 'Bearer test-key' },
    });
    const res = makeRes();
    await handler(req, res as any);
    // video-router catches per-site errors and emits stats.failed instead of
    // throwing — REST reflects that with 200 + populated stats.failed.
    expect(res.status).toBe(200);
    expect(res.body.data.stats.failed.length).toBeGreaterThan(0);
    expect(res.body.data.stats.succeeded.length).toBe(0);
  });
});