import type { IncomingMessage } from 'node:http';
import type { Deps } from '../api/rest.js';
import { log } from '../core/logger.js';
import { searchVideos, type RouterDeps } from './video-router.js';
import { buildAbsoluteUrl } from './url-builder.js';
import type { VideoSearchResponse, VideoDownloadResult } from './video-types.js';
import type { VideoSubsystem } from '../mcp/mcp.js';

export interface VideoHandlerCtx {
  deps: Deps;
  video: VideoSubsystem;
  req: IncomingMessage;
  clientHost: string | null;
}

export async function runVideoSearch(
  input: { query: string; platform?: string; limit?: number },
  ctx: VideoHandlerCtx,
): Promise<VideoSearchResponse> {
  log.info('video.search.start', { query: input.query, platform: input.platform ?? null, limit: input.limit ?? null });
  try {
    const routerDeps: RouterDeps = {
      runOpencli: async (site, command, argv) => {
        const r = await ctx.deps.run(site, command, argv);
        const ok = !!r.ok;
        return {
          ok,
          exitCode: ok ? 0 : 1,
          stdout: ok ? JSON.stringify(r.data ?? {}) : '',
          stderr: ok ? '' : (r.stderr ?? JSON.stringify(r.data ?? {})),
        };
      },
    };
    const res = await searchVideos(
      { query: input.query, platform: input.platform, limit: input.limit },
      routerDeps,
    );
    log.info('video.search.done', {
      query: input.query,
      platform: input.platform ?? null,
      results: res.results.length,
      ok: res.stats.succeeded.length,
      failed: res.stats.failed.length,
    });
    return res;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'EMPTY_QUERY';
    log.warn('video.search.error', { query: input.query, platform: input.platform ?? null, code, message: (err as Error).message });
    throw err;
  }
}

export async function runVideoDownload(
  input: { urls: string[]; quality?: string },
  ctx: VideoHandlerCtx,
): Promise<{ results: VideoDownloadResult[] }> {
  const q = input.quality ?? 'best';
  log.info('video.download.start', { urls: input.urls.map((u) => new URL(u).hostname), quality: q });
  const t0 = Date.now();
  const results = await ctx.video.pool.downloadMany(input.urls, q);
  const patched = results.map((r, i) => {
    if (!r.ok) return r;
    const abs = buildAbsoluteUrl(ctx.req, r.download_url);
    return { ...r, url: input.urls[i], download_url: abs ?? r.download_url };
  });
  log.info('video.download.done', {
    urls: input.urls.map((u) => new URL(u).hostname),
    quality: q,
    ms: Date.now() - t0,
    ok_count: patched.filter((r) => r.ok).length,
    fail_count: patched.length - patched.filter((r) => r.ok).length,
    methods: patched.filter((r) => r.ok).map((r) => (r as { method?: string }).method ?? '?'),
    errors: patched.filter((r) => !r.ok).map((r) => (r as { error_code?: string }).error_code ?? '?'),
  });
  return { results: patched };
}