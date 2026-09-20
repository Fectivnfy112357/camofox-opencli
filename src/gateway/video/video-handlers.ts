import type { IncomingMessage } from 'node:http';
import type { Deps } from '../api/rest.js';
import { log } from '../core/logger.js';
import { buildAbsoluteUrl } from './url-builder.js';
import type { VideoDownloadResult } from './video-types.js';
import type { VideoSubsystem } from '../mcp/mcp.js';

export interface VideoHandlerCtx {
  deps: Deps;
  video: VideoSubsystem;
  req: IncomingMessage;
  clientHost: string | null;
}

export async function runVideoDownload(
  input: { urls: string[]; quality?: string },
  ctx: VideoHandlerCtx,
): Promise<{ results: VideoDownloadResult[] }> {
  // Default quality is `720p` when the caller omits `quality`. The legacy
  // `best` sentinel still resolves to 1080p in the format-selector mapping
  // below — both stay as accepted input values from REST/MCP clients to
  // avoid breaking older agents.
  const q = input.quality ?? '720p';
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