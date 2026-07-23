import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DouyinBrowserDownloader } from '../../src/gateway/video/douyin-browser-downloader.js';
import { TempStore } from '../../src/gateway/video/temp-store.js';

describe('DouyinBrowserDownloader', () => {
  it('downloads the Camofox-resolved media URL through curl and the configured proxy', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-browser-download-'));
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/tabs')) return new Response(JSON.stringify({ tabId: 'tab-1' }), { status: 200 });
      if (url.endsWith('/navigate')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/evaluate')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            userAgent: 'Mozilla/5.0 Firefox/152.0',
            mediaUrl: 'https://v26-web.douyinvod.com/path/video.mp4?signature=ok',
          },
        }), { status: 200 });
      }
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    });
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('curl');
      expect(args).toEqual(expect.arrayContaining([
        '--proxy', 'http://host.docker.internal:20172',
        '--user-agent', 'Mozilla/5.0 Firefox/152.0',
        '--referer', 'https://www.douyin.com/',
      ]));
      await fs.writeFile(args[args.indexOf('--output') + 1], 'video');
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    });
    const downloader = new DouyinBrowserDownloader({
      baseUrl: 'http://camofox:9377',
      userId: 'user-1',
      outputDir,
      tempStore: new TempStore({ tmpDir: outputDir, ttlMs: 60 * 60 * 1000 }),
      proxyUrl: 'http://host.docker.internal:20172',
      fetchImpl,
      exec,
      pollIntervalMs: 0,
    });

    try {
      const result = await downloader.download('https://www.douyin.com/video/7660110395654294810');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.method).toBe('camofox');
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://camofox:9377/tabs/tab-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
