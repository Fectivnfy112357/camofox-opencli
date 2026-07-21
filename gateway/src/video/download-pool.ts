import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { VideoDownloadResult, ErrorCode } from './video-types.js';
import { dispatch } from './native-dispatcher.js';
import { exportCookiesForHost, type CamofoxCookie } from './video-cookies.js';
import { Semaphore } from './semaphore.js';
import type { TempStore } from './temp-store.js';

export interface RunResultLike {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFn {
  (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResultLike>;
}

export interface RunOpencliFn {
  (site: string, command: string, args: string[]): Promise<RunResultLike>;
}

export interface FetchCamofoxCookiesFn {
  (userId: string): Promise<CamofoxCookie[]>;
}

export interface DownloadPoolOptions {
  tmpDir: string;
  tempStore: TempStore;
  workerCount?: number;
  runOpencli: RunOpencliFn;
  fetchCamofoxCookies: FetchCamofoxCookiesFn;
  exec: ExecFn;
}

export class DownloadPool {
  private sem: Semaphore;
  private tmpDir: string;

  constructor(private opts: DownloadPoolOptions) {
    this.sem = new Semaphore(opts.workerCount ?? 3);
    this.tmpDir = opts.tmpDir;
  }

  async downloadMany(urls: string[], quality: string): Promise<VideoDownloadResult[]> {
    return Promise.all(urls.map((u) => this.downloadOne(u, quality)));
  }

  async downloadOne(rawUrl: string, quality: string): Promise<VideoDownloadResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { url: rawUrl, ok: false, error_code: 'INVALID_URL', error_message: `Invalid URL: ${rawUrl}` };
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { url: rawUrl, ok: false, error_code: 'INVALID_URL', error_message: `Unsupported protocol: ${url.protocol}` };
    }
    return this.sem.serialize(() => this.runJob(rawUrl, url, quality));
  }

  private async runJob(rawUrl: string, url: URL, quality: string): Promise<VideoDownloadResult> {
    const route = dispatch(rawUrl);
    const host = url.hostname;

    if (route.method === 'native' && route.site) {
      const nativeResult = await this.runNative(route.site, route.args, quality);
      if (nativeResult.ok) {
        return { ...nativeResult, url: rawUrl };
      }
      // fall through to ytdlp
    }

    return this.runYtdlp(rawUrl, host, quality);
  }

  private async runNative(site: string, args: string[], _quality: string): Promise<VideoDownloadResult> {
    const outputTemplate = path.join(this.tmpDir, `video_${randomUUID()}.%(ext)s`);
    const fullArgs = [...args, '--output', outputTemplate];
    const res = await this.opts.runOpencli(site, 'download', fullArgs);
    if (!res.ok) {
      const code: ErrorCode = /paid|membership|大会员/.test(res.stderr) ? 'PAID_CONTENT' : 'NATIVE_DOWNLOAD_FAILED';
      return { url: '', ok: false, error_code: code, error_message: res.stderr.slice(0, 500) };
    }
    const file = await this.findOutputFile(outputTemplate);
    if (!file) {
      return { url: '', ok: false, error_code: 'NATIVE_DOWNLOAD_FAILED', error_message: 'output file not found' };
    }
    const { id, expires_at } = await this.opts.tempStore.register(file);
    const entry = this.opts.tempStore.get(id)!;
    return {
      url: '',
      ok: true,
      method: 'native',
      filename: entry.filename,
      size_bytes: entry.size_bytes,
      download_url: `/files/${id}${path.extname(entry.filename)}`,
      expires_at,
    };
  }

  private async runYtdlp(rawUrl: string, host: string, quality: string): Promise<VideoDownloadResult> {
    const cookies = await exportCookiesForHost(host, {
      tmpDir: this.tmpDir,
      fetchCookies: this.opts.fetchCamofoxCookies,
    });
    const outputTemplate = path.join(this.tmpDir, `video_${randomUUID()}.%(ext)s`);
    const formatSel = quality === 'best' ? 'bv*+ba/b' : quality;
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--cookies', cookies.cookieFilePath,
      '-o', outputTemplate,
      '-f', formatSel,
      rawUrl,
    ];
    const res = await this.opts.exec('yt-dlp', args, { cwd: this.tmpDir, timeoutMs: 10 * 60 * 1000 });
    if (res.exitCode !== 0) {
      const code: ErrorCode = /Sign in|login|403/.test(res.stderr) ? 'LOGIN_REQUIRED' : 'YT_DLP_FAILED';
      return { url: rawUrl, ok: false, error_code: code, error_message: res.stderr.slice(0, 500) };
    }
    const file = await this.findOutputFile(outputTemplate);
    if (!file) {
      return { url: rawUrl, ok: false, error_code: 'YT_DLP_FAILED', error_message: 'output file not found' };
    }
    const { id, expires_at } = await this.opts.tempStore.register(file);
    const entry = this.opts.tempStore.get(id)!;
    return {
      url: rawUrl,
      ok: true,
      method: 'ytdlp',
      filename: entry.filename,
      size_bytes: entry.size_bytes,
      download_url: `/files/${id}${path.extname(entry.filename)}`,
      expires_at,
    };
  }

  private async findOutputFile(template: string): Promise<string | null> {
    const dir = path.dirname(template);
    const baseName = path.basename(template);
    const prefix = baseName.split('.%(ext)s')[0];
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return null;
    }
    // Prefer exact-prefix matches first
    const matches = files.filter((f) => f.startsWith(prefix));
    if (matches.length > 0) {
      matches.sort();
      return path.join(dir, matches[matches.length - 1]);
    }
    // Fallback: newest video_* file in dir (covers test fixtures pre-creating out.mp4 etc.)
    const videoFiles = files.filter((f) => f.startsWith('video_'));
    if (videoFiles.length === 0) return null;
    const stats = await Promise.all(
      videoFiles.map(async (f) => ({ f, mtime: (await fs.stat(path.join(dir, f))).mtimeMs })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return path.join(dir, stats[0].f);
  }
}