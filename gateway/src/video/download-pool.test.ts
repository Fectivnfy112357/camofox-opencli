import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DownloadPool } from './download-pool.js';
import { TempStore } from './temp-store.js';

describe('DownloadPool', () => {
  let tmpDir: string;
  let store: TempStore;
  let runOpencli: any;
  let fetchCamofoxCookies: any;
  let exec: any;

  function makePool(workerCount = 3): DownloadPool {
    return new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount,
      runOpencli,
      fetchCamofoxCookies,
      exec,
    });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-dlpool-'));
    store = new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
    runOpencli = vi.fn();
    fetchCamofoxCookies = vi.fn().mockResolvedValue([]);
    exec = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns INVALID_URL for non-http URLs without invoking anything', async () => {
    const pool = makePool();
    const r = await pool.downloadOne('ftp://x/y', 'best');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe('INVALID_URL');
  });

  it('runs yt-dlp path with cookies file and registers output', async () => {
    const execFn = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('yt-dlp');
      expect(args).toEqual(expect.arrayContaining([expect.stringMatching(/--cookies/), expect.stringMatching(/-o/)]));
      // Simulate yt-dlp writing the file using the template's path
      const tpl = args[args.indexOf('-o') + 1];
      const realExt = tpl.replace('.%(ext)s', '.mp4');
      await fs.writeFile(realExt, 'fakevideo');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const pool = new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount: 3,
      runOpencli,
      fetchCamofoxCookies,
      exec: execFn,
    });
    const r = await pool.downloadOne('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'best');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe('ytdlp');
      expect(r.filename).toMatch(/^video_[0-9a-f-]{36}\.mp4$/);
      expect(r.download_url).toMatch(/^\/files\/[0-9a-f-]{36}\.mp4$/);
    }
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to yt-dlp when native download fails', async () => {
    const execFn = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      const tpl = args[args.indexOf('-o') + 1];
      const realExt = tpl.replace('.%(ext)s', '.mp4');
      await fs.writeFile(realExt, 'fb');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const localRun = vi.fn().mockResolvedValue({ ok: false, exitCode: 1, stdout: '', stderr: 'paid' });
    const pool = new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount: 3,
      runOpencli: localRun,
      fetchCamofoxCookies,
      exec: execFn,
    });
    const r = await pool.downloadOne('https://www.bilibili.com/video/BV1xx411c7mD', 'best');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('ytdlp');
    expect(localRun).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('returns YT_DLP_FAILED when yt-dlp exits non-zero', async () => {
    const execFn = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '403 forbidden' });
    const pool = new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount: 3,
      runOpencli,
      fetchCamofoxCookies,
      exec: execFn,
    });
    const r = await pool.downloadOne('https://example.com/video.mp4', 'best');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error_code === 'YT_DLP_FAILED' || r.error_code === 'LOGIN_REQUIRED').toBe(true);
    }
  });

  it('downloadMany caps parallelism at workerCount', async () => {
    let active = 0;
    let maxActive = 0;
    const execFn = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.mp4`), 'x');
    }
    const pool = new DownloadPool({
      tmpDir,
      tempStore: store,
      workerCount: 3,
      runOpencli,
      fetchCamofoxCookies,
      exec: execFn,
    });
    const results = await pool.downloadMany([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://example.com/e',
    ], 'best');
    expect(results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});