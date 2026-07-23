import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoDownloadResult } from './video-types.js';
import type { TempStore } from './temp-store.js';
import type { ExecFn } from './download-pool.js';

interface BrowserMedia {
  userAgent: string;
  mediaUrl: string;
}

export interface DouyinBrowserDownloaderOptions {
  baseUrl: string;
  apiKey?: string | null;
  userId: string;
  outputDir: string;
  tempStore: TempStore;
  proxyUrl?: string | null;
  fetchImpl?: typeof fetch;
  exec: ExecFn;
  pollIntervalMs?: number;
  mediaTimeoutMs?: number;
}

/** Downloads Douyin media through the authenticated Camofox browser session. */
export class DouyinBrowserDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly mediaTimeoutMs: number;

  constructor(private readonly opts: DouyinBrowserDownloaderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.mediaTimeoutMs = opts.mediaTimeoutMs ?? 60_000;
  }

  async download(url: string): Promise<VideoDownloadResult> {
    let tabId: string | null = null;
    try {
      tabId = await this.createTab();
      await this.request(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
        method: 'POST',
        body: JSON.stringify({ userId: this.opts.userId, url }),
      });
      const media = await this.waitForMedia(tabId);
      const outputPath = path.join(this.opts.outputDir, `video_${randomUUID()}.mp4`);
      const args = [
        '--fail', '--location', '--retry', '2',
        ...(this.opts.proxyUrl ? ['--proxy', this.opts.proxyUrl] : []),
        '--user-agent', media.userAgent,
        '--referer', 'https://www.douyin.com/',
        '--output', outputPath,
        media.mediaUrl,
      ];
      const result = await this.opts.exec('curl', args, { cwd: this.opts.outputDir, timeoutMs: 10 * 60 * 1000 });
      if (result.exitCode !== 0) {
        return { url, ok: false, error_code: 'CAMOFOX_DOWNLOAD_FAILED', error_message: result.stderr.slice(0, 500) };
      }
      const { id, expires_at } = await this.opts.tempStore.register(outputPath);
      const entry = this.opts.tempStore.get(id)!;
      return { url, ok: true, method: 'camofox', filename: entry.filename, size_bytes: entry.size_bytes, download_url: `/files/${id}${path.extname(entry.filename)}`, expires_at };
    } catch (err) {
      return { url, ok: false, error_code: 'CAMOFOX_DOWNLOAD_FAILED', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
    } finally {
      if (tabId) {
        try {
          await this.request(`/tabs/${encodeURIComponent(tabId)}`, { method: 'DELETE' });
        } catch {
          // A failed cleanup must not hide an otherwise valid download result.
        }
      }
    }
  }

  private async createTab(): Promise<string> {
    const data = await this.request('/tabs', {
      method: 'POST',
      body: JSON.stringify({ userId: this.opts.userId, sessionKey: `video-download-${randomUUID()}` }),
    }) as { tabId?: string; id?: string };
    const tabId = data.tabId ?? data.id;
    if (!tabId) throw new Error('Camofox did not return a tab ID');
    return tabId;
  }

  private async waitForMedia(tabId: string): Promise<BrowserMedia> {
    const deadline = Date.now() + this.mediaTimeoutMs;
    while (Date.now() < deadline) {
      const data = await this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({
          userId: this.opts.userId,
          timeout: 10_000,
          expression: '(() => ({ userAgent: navigator.userAgent, mediaUrl: Array.from(document.querySelectorAll("video")).map((video) => video.currentSrc).find((src) => src && !src.startsWith("blob:")) || "" }))()',
        }),
      }) as { result?: BrowserMedia };
      if (data.result?.mediaUrl?.startsWith('https://') && data.result.userAgent) return data.result;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error('Timed out waiting for Camofox to resolve Douyin media');
  }

  private async request(endpoint: string, init: RequestInit): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const res = await this.fetchImpl(`${this.opts.baseUrl}${endpoint}`, { ...init, headers });
    if (!res.ok) throw new Error(`Camofox HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}
