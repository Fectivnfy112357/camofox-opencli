import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { VideoDownloadResult, ErrorCode } from './video-types.js';
import { exportCookiesForHost, type CamofoxCookie } from './video-cookies.js';
import { Semaphore } from './semaphore.js';
import type { TempStore } from './temp-store.js';
import { log } from '../core/logger.js';

export interface RunResultLike {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFn {
  (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResultLike>;
}

export interface FetchCamofoxCookiesFn {
  (userId: string): Promise<CamofoxCookie[]>;
}

export interface DownloadPoolOptions {
  /** Directory for per-request Netscape cookie staging files. yt-dlp
   *  reads these via `--cookies <path>` and the file may be left on disk
   *  for diagnostics; should be a host-visible mount if you want to
   *  inspect them. */
  cookieDir: string;
  /** Directory yt-dlp writes downloaded videos into. Independent from
   *  cookieDir so downloaded files don't share a directory with cookie
   *  blobs — bind-mount this if you want videos visible on the host. */
  outputDir: string;
  tempStore: TempStore;
  workerCount?: number;
  fetchCamofoxCookies: FetchCamofoxCookiesFn;
  wakeBrowser?: (userId: string) => Promise<void>;
  exec: ExecFn;
  userId: string;
  /** Optional proxy URL (http://host:port). When set, yt-dlp receives
   *  `--proxy <url>` so video downloads exit via v2raya instead of the
   *  bare container IP. */
  proxyUrl?: string | null;
}

export class DownloadPool {
  private sem: Semaphore;
  private cookieDir: string;
  private outputDir: string;

  constructor(private opts: DownloadPoolOptions) {
    this.sem = new Semaphore(opts.workerCount ?? 3);
    this.cookieDir = opts.cookieDir;
    this.outputDir = opts.outputDir;
    log.info('download-pool.ctor', { userId: opts.userId });
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
    return this.sem.serialize(() => this.runYtdlp(rawUrl, url.hostname, quality));
  }

  // Single download path: yt-dlp with Camofox cookies injected.
  //
  // We deliberately do NOT route bilibili / instagram through opencli's native
  // `download` commands. Those wrappers are thin shims around yt-dlp anyway —
  // they spawn another opencli process, do another browser round-trip, and
  // re-fetch cookies — so they used to fail in ways yt-dlp directly didn't
  // (positional vs --bvid args, stale yt-dlp client, SESSDATA scoping). One
  // yt-dlp invocation per URL with cookies fetched once per request keeps the
  // behavior uniform across all 8 supported video sites.
  private async runYtdlp(rawUrl: string, host: string, quality: string): Promise<VideoDownloadResult> {
    log.info('download.run-ytdlp', { url: rawUrl, host, quality, userId: this.opts.userId });
    const cookies = await exportCookiesForHost(host, {
      tmpDir: this.cookieDir,
      fetchCookies: this.opts.fetchCamofoxCookies,
      wakeBrowser: this.opts.wakeBrowser,
      userId: this.opts.userId,
    });
    const outputTemplate = path.join(this.outputDir, `video_${randomUUID()}.%(ext)s`);
    // Quality is a height cap: bestvideo picks the best video stream ≤ N px tall,
    // bestaudio the best audio. Falls back to the single best combined stream
    // if the site doesn't expose separate video/audio (rare; youtube always
    // does, but legacy / non-dash sites may not). `worst` is intentionally the
    // lowest-only combined stream (no DASH merge required).
    const formatSel = quality === 'best'
      ? 'bv*+ba/b'
      : quality === 'worst'
        ? 'worst'
        : `bv*[height<=${parseInt(quality, 10)}]+ba/b[height<=${parseInt(quality, 10)}]`;
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--cookies', cookies.cookieFilePath,
      '-o', outputTemplate,
      '-f', formatSel,
      ...(this.opts.proxyUrl ? ['--proxy', this.opts.proxyUrl] : []),
      rawUrl,
    ];
    const res = await this.opts.exec('yt-dlp', args, { cwd: this.outputDir, timeoutMs: 10 * 60 * 1000 });
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
