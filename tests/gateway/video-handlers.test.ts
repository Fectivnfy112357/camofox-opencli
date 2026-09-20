import { describe, it, expect, vi } from 'vitest';
import { runVideoDownload, type VideoHandlerCtx } from '../../src/gateway/video/video-handlers.js';
import type { Deps } from '../../src/gateway/api/rest.js';
import type { Manifest } from '../../src/gateway/core/manifest.js';
import type { Config } from '../../src/gateway/core/config.js';
import type { VideoSubsystem } from '../../src/gateway/mcp/mcp.js';

function makeDeps(): Deps {
  const manifest: Manifest = {
    getSiteHelp: vi.fn().mockReturnValue([]),
    listSites: vi.fn().mockReturnValue([]),
    searchSites: vi.fn().mockReturnValue([]),
  } as unknown as Manifest;
  const cfg: Config = {
    apiKey: '',
    manifestPath: '/tmp/m.json',
    tmpDir: '/tmp',
    logDir: '/tmp',
    logLevel: 'info',
    cookieDir: '/tmp',
    outputDir: '/tmp',
    proxyUrl: null,
  };
  return {
    cfg,
    manifest,
    run: vi.fn(),
  };
}

function makeCtx(deps: Deps): VideoHandlerCtx {
  const video: VideoSubsystem = {
    pool: { downloadMany: vi.fn() } as unknown as VideoSubsystem['pool'],
    fetchCookies: vi.fn(),
  };
  return {
    deps,
    video,
    req: { headers: {} } as unknown as import('node:http').IncomingMessage,
    clientHost: 'testhost',
  };
}

describe('runVideoDownload', () => {
  it('returns results array from pool.downloadMany', async () => {
    const deps = makeDeps();
    const ctx = makeCtx(deps);
    (ctx.video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
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
    const out = await runVideoDownload({ urls: ['https://x/y'] }, ctx);
    expect(out.results[0].ok).toBe(true);
  });

  it('forwards explicit quality through to pool.downloadMany', async () => {
    const deps = makeDeps();
    const ctx = makeCtx(deps);
    const poolMock = ctx.video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>;
    poolMock.mockResolvedValue([
      {
        url: 'https://x/y', ok: true, method: 'ytdlp', filename: 'a.mp4',
        size_bytes: 1, download_url: '/files/a.mp4', expires_at: '2099-01-01T00:00:00Z',
      },
    ]);
    await runVideoDownload({ urls: ['https://x/y'], quality: '480p' }, ctx);
    expect(poolMock).toHaveBeenCalledWith(['https://x/y'], '480p');
  });

  it('defaults to 720p when caller omits quality', async () => {
    // Regression guard: legacy default was `best`, which mapped to the
    // unbounded `bv*+ba/b` and reliably hit YouTube SABR/player-API rate
    // limits on shared-proxy exits. New default is the height-capped
    // `720p` selector that has been empirically reliable.
    const deps = makeDeps();
    const ctx = makeCtx(deps);
    const poolMock = ctx.video.pool.downloadMany as unknown as ReturnType<typeof vi.fn>;
    poolMock.mockResolvedValue([
      {
        url: 'https://x/y', ok: true, method: 'ytdlp', filename: 'a.mp4',
        size_bytes: 1, download_url: '/files/a.mp4', expires_at: '2099-01-01T00:00:00Z',
      },
    ]);
    await runVideoDownload({ urls: ['https://x/y'] }, ctx);
    expect(poolMock).toHaveBeenCalledWith(['https://x/y'], '720p');
  });
});