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
  /** Directory where yt-dlp stderr is appended on failure. Same path as
   *  the gateway JSONL log so operators can inspect both from a single
   *  host bind-mount. Optional — when omitted, stderr is not persisted. */
  logDir?: string;
  /** Optional proxy URL (http://host:port). When set, yt-dlp receives
   *  `--proxy <url>` so video downloads exit via v2raya instead of the
   *  bare container IP. */
  proxyUrl?: string | null;
  /** When true, yt-dlp receives `--verbose` so its per-request network
   *  errors (cert verify failures, connection reset codes, fragment-
   *  level retries, SABR/PO token warnings, etc.) appear in stderr.
   *  Disabled by default because verbose output is noisy; enable when
   *  diagnosing intermittent failures by setting YTDLP_VERBOSE=1 on the
   *  gateway process. */
  verbose?: boolean;
  douyinDownloader?: { download(url: string): Promise<VideoDownloadResult> };
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

  /** Append a single yt-dlp run's stderr (full, untruncated) to
   *  `<logDir>/ytdlp-errors.log` with a header line carrying the URL,
   *  exit code, format selector, proxy flag, and ISO timestamp so
   *  subsequent grep / awk can group runs by URL or by time window.
   *  Silent on filesystem error — the download result has already
   *  been computed at the call site and the log is purely diagnostic.
   *  Recorded for BOTH successful and failed runs: when a formerly-
   *  working download starts failing intermittently, the last-good
   *  yt-dlp transcript is often the only evidence of what changed. */
  private async appendYtdlpLog(
    rawUrl: string,
    host: string,
    quality: string,
    formatSel: string,
    proxyInjected: boolean,
    exitCode: number,
    durationMs: number,
    outputFile: string | null,
    outputBytes: number | null,
    stderr: string,
  ): Promise<void> {
    if (!this.opts.logDir) return;
    const filePath = `${this.opts.logDir}/ytdlp-runs.log`;
    const header = [
      '',
      `===== ${new Date().toISOString()}`,
      `url=${rawUrl}`,
      `host=${host}`,
      `quality=${quality}`,
      `format=${formatSel}`,
      `proxy=${proxyInjected ? this.opts.proxyUrl : 'off'}`,
      `exit=${exitCode}`,
      `duration_ms=${durationMs}`,
      `output_file=${outputFile ?? 'none'}`,
      `output_bytes=${outputBytes ?? 'n/a'}`,
      `stderr_bytes=${stderr.length}`,
      '=====',
      '',
    ].join('\n');
    await fs.appendFile(filePath, header + stderr + (stderr.endsWith('\n') ? '' : '\n'), { encoding: 'utf8' });
  }

  async downloadMany(urls: string[], quality: string): Promise<VideoDownloadResult[]> {
    const t0 = Date.now();
    log.info('download.many.start', { count: urls.length, quality, userId: this.opts.userId });
    const results = await Promise.all(urls.map((u) => this.downloadOne(u, quality)));
    log.info('download.many.end', {
      count: urls.length,
      quality,
      userId: this.opts.userId,
      ms: Date.now() - t0,
      ok: results.filter((r) => r.ok).length,
      fail: results.filter((r) => !r.ok).length,
      ok_methods: results.filter((r) => r.ok).map((r) => (r as { method?: string }).method ?? '?'),
      fail_codes: results.filter((r) => !r.ok).map((r) => (r as { error_code?: string }).error_code ?? '?'),
    });
    return results;
  }

  async downloadOne(rawUrl: string, quality: string): Promise<VideoDownloadResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      log.info('download.one.invalid-url', { url: rawUrl });
      return { url: rawUrl, ok: false, error_code: 'INVALID_URL', error_message: `Invalid URL: ${rawUrl}` };
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      log.info('download.one.unsupported-protocol', { url: rawUrl, protocol: url.protocol });
      return { url: rawUrl, ok: false, error_code: 'INVALID_URL', error_message: `Unsupported protocol: ${url.protocol}` };
    }
    const t0 = Date.now();
    log.info('download.one.start', { url: rawUrl, host: url.hostname, quality, userId: this.opts.userId });
    const result = await this.sem.serialize(() => {
      if (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) {
        return this.opts.douyinDownloader?.download(rawUrl) ?? this.runYtdlp(rawUrl, url.hostname, quality);
      }
      return this.runYtdlp(rawUrl, url.hostname, quality);
    });
    log.info('download.one.end', {
      url: rawUrl,
      host: url.hostname,
      quality,
      userId: this.opts.userId,
      ms: Date.now() - t0,
      ok: result.ok,
      method: (result as { method?: string }).method ?? null,
      error_code: !result.ok ? (result as { error_code?: string }).error_code ?? null : null,
      size_bytes: result.ok ? (result as { size_bytes?: number }).size_bytes ?? null : null,
    });
    return result;
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
    const t0 = Date.now();
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
    // lowest-only combined stream (no DASH merge required). `best` is a
    // legacy sentinel kept for backward-compat with older clients — it now
    // maps to 1080p instead of the unbounded `bv*+ba/b` so it hits the same
    // height-capped branch as the explicit quality values (the unbounded
    // selector reliably hit YouTube's player-API rate limit / SABR challenge
    // on `textvision.top`'s v2raya exit IP).
    const formatSel = quality === 'worst'
      ? 'worst'
      : quality === 'best' || quality === '1080p'
        ? 'bv*[height<=1080]+ba/b[height<=1080]'
        : `bv*[height<=${parseInt(quality, 10)}]+ba/b[height<=${parseInt(quality, 10)}]`;
    const proxyInjected = Boolean(this.opts.proxyUrl);
    const args = [
      // --no-progress: keep stderr clean of the carriage-return progress
      // bar that would shred our per-run log entry into a single line.
      // We deliberately do NOT pass --no-warnings here — operators need
      // yt-dlp's WARNING/ERROR lines (e.g. cookie expiry, format
      // selection notes) in the per-run transcript for diagnostics.
      // --newline: emits each progress update on its own line, which
      // combines with --no-progress in practice is one entry per chunk.
      '--no-playlist',
      '--newline',
      '--no-progress',
      // --verbose is gated on opts.verbose so we can flip it per-deploy
      // without rebuilding the image. Verbose output adds ~1-5KB per
      // run; the per-run log entry already carries stderr_bytes so the
      // line is recoverable even without `--verbose`.
      ...(this.opts.verbose ? ['--verbose'] : []),
      '--cookies', cookies.cookieFilePath,
      '-o', outputTemplate,
      '-f', formatSel,
      ...(this.opts.proxyUrl ? ['--proxy', this.opts.proxyUrl] : []),
      rawUrl,
    ];
    log.info('download.ytdlp.spawn', {
      url: rawUrl,
      host,
      quality,
      format: formatSel,
      verbose: this.opts.verbose ?? false,
      proxy: proxyInjected,
      cookie_path: cookies.cookieFilePath,
      cookie_count: cookies.cookieCount,
      output_template: outputTemplate,
      // Do NOT log the full argv in production — cookie path is enough
      // to debug. The rest can be reconstructed from the constants.
    });
    const res = await this.opts.exec('yt-dlp', args, { cwd: this.outputDir, timeoutMs: 10 * 60 * 1000 });
    const stderr = res.stderr ?? '';

    if (res.exitCode !== 0) {
      const code: ErrorCode = /Sign in|login|403/.test(stderr) ? 'LOGIN_REQUIRED' : 'YT_DLP_FAILED';
      log.warn('download.ytdlp.failed', {
        url: rawUrl, host, quality, exit: res.exitCode, code,
        stderr_head: stderr.slice(0, 200),
      });
      // Record failure with full stderr. The header carries the exit
      // code so grep "^exit=[^0]" finds this block.
      void this.appendYtdlpLog(
        rawUrl, host, quality, formatSel,
        proxyInjected, res.exitCode, Date.now() - t0,
        null, null, stderr,
      ).catch(() => {});
      return { url: rawUrl, ok: false, error_code: code, error_message: stderr.slice(0, 500) };
    }
    const file = await this.findOutputFile(outputTemplate);
    if (!file) {
      log.warn('download.ytdlp.no-output', { url: rawUrl, host, quality, exit: res.exitCode });
      void this.appendYtdlpLog(
        rawUrl, host, quality, formatSel,
        proxyInjected, res.exitCode, Date.now() - t0,
        null, null, stderr,
      ).catch(() => {});
      return { url: rawUrl, ok: false, error_code: 'YT_DLP_FAILED', error_message: 'output file not found' };
    }
    let sizeBytes: number | null = null;
    try {
      sizeBytes = (await fs.stat(file)).size;
    } catch { /* stat failure is non-fatal for the response */ }
    const { id, expires_at } = await this.opts.tempStore.register(file);
    const entry = this.opts.tempStore.get(id)!;
    log.info('download.ytdlp.success', {
      url: rawUrl, host, quality, ms: Date.now() - t0, size_bytes: sizeBytes, filename: entry.filename,
    });
    // Record success AFTER finding the output file so the header
    // carries the real size_bytes (which is what makes the ytdlp-runs
    // log useful for "did YouTube send 0 bytes of video this time?"
    // spot-checks during intermittent failure debugging).
    void this.appendYtdlpLog(
      rawUrl, host, quality, formatSel,
      proxyInjected, res.exitCode, Date.now() - t0,
      file, sizeBytes, stderr,
    ).catch(() => {});
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
