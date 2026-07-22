import { VIDEO_SITES, DEFAULT_PLATFORMS, ALL_PLATFORMS, isVideoSite, type VideoSite, type VideoSearchResponse, type VideoSearchResult } from './video-types.js';
import { Semaphore } from './semaphore.js';

export type RunResultLike = { ok: boolean; exitCode: number; stdout: string; stderr: string };

// Local copy of RunOpencliFn: the public one in download-pool.ts is gone now
// that video_download always goes through yt-dlp. searchVideos still needs
// to spawn opencli per platform — keep its type local to this file.
type RunOpencliFn = (site: string, command: string, args: string[]) => Promise<RunResultLike>;

export interface SearchInput {
  query: string;
  platform?: string;
  limit?: number;
}

export interface RouterDeps {
  runOpencli: RunOpencliFn;
  concurrency?: number;
}

function resolvePlatforms(input: SearchInput): VideoSite[] {
  if (!input.platform) return [...DEFAULT_PLATFORMS];
  if (input.platform === ALL_PLATFORMS) return [...VIDEO_SITES];
  if (!isVideoSite(input.platform)) {
    throw Object.assign(new Error(`INVALID_PLATFORM: ${input.platform}`), { code: 'INVALID_PLATFORM' });
  }
  return [input.platform];
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return 10;
  if (limit > 30) return 30;
  return limit;
}

async function searchOneSite(
  site: VideoSite,
  query: string,
  limit: number,
  runOpencli: RunOpencliFn,
): Promise<{ ok: true; rows: VideoSearchResult[] } | { ok: false; error: string }> {
  const args = [query, '--format', 'json', '--limit', String(limit)];
  const res = await runOpencli(site, 'search', args);
  if (!res.ok) {
    return { ok: false, error: res.stderr || `exit ${res.exitCode}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: `invalid JSON: ${res.stdout.slice(0, 200)}` };
  }
  const rows: any[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.data) ? (parsed as any).data : [];
  const mapped = rows.map((row: any) => mapRow(site, row)).filter((r): r is VideoSearchResult => r !== null);
  return { ok: true, rows: mapped };
}

function mapRow(site: VideoSite, row: any): VideoSearchResult | null {
  // opencli adapters expose varying column shapes (id/bvid/aweme_id vs. plain rank).
  // Fall back through every plausible id column, then use `rank` as a last resort
  // so the result row can still be linked back to its source list.
  const idRaw = row.id ?? row.bvid ?? row.video_id ?? row.aweme_id ?? row.shortcode ?? row.rank;
  const id = idRaw != null ? String(idRaw) : '';
  const title = String(row.title ?? row.desc ?? row.name ?? '');
  const url = String(row.url ?? row.video_url ?? (id ? canonicalUrl(site, id) : ''));
  if (!id || !title || !url) return null;
  return {
    platform: site,
    id,
    title,
    url,
    author: row.author ?? row.user ?? row.nickname,
    duration: row.duration,
    // `score` is the universal rank/heat column across adapters; `views/play_count/view_count`
    // are the optional numeric view-count columns some adapters populate.
    views: typeof row.views === 'number'
      ? row.views
      : typeof row.plays === 'number'
        ? row.plays
        : typeof row.score === 'number'
          ? row.score
          : row.view_count ?? row.play_count,
    thumbnail: row.thumbnail ?? row.cover ?? row.pic,
  };
}

function canonicalUrl(site: VideoSite, id: string): string {
  switch (site) {
    case 'bilibili': return `https://www.bilibili.com/video/${id}`;
    case 'youtube': return `https://www.youtube.com/watch?v=${id}`;
    case 'douyin': return `https://www.douyin.com/video/${id}`;
    case 'tiktok': return `https://www.tiktok.com/@_/video/${id}`;
    case 'instagram': return `https://www.instagram.com/p/${id}/`;
    case 'xiaohongshu': return `https://www.xiaohongshu.com/explore/${id}`;
    case 'weibo': return `https://weibo.com/${id}`;
    case 'twitter': return `https://x.com/i/status/${id}`;
  }
}

export async function searchVideos(input: SearchInput, deps: RouterDeps): Promise<VideoSearchResponse> {
  const query = (input.query ?? '').trim();
  if (!query) throw Object.assign(new Error('EMPTY_QUERY'), { code: 'EMPTY_QUERY' });
  const sites = resolvePlatforms(input);
  const limit = clampLimit(input.limit);
  const sem = new Semaphore(deps.concurrency ?? 3);
  const settled = await Promise.allSettled(
    sites.map((site) => sem.serialize(async () => {
      try {
        const r = await searchOneSite(site, query, limit, deps.runOpencli);
        if (r.ok) return { site, ok: true as const, results: r.rows, error: null as string | null };
        return { site, ok: false as const, results: [], error: r.error };
      } catch (err) {
        return { site, ok: false as const, results: [], error: (err as Error).message };
      }
    })),
  );
  const allResults: VideoSearchResult[] = [];
  const succeeded: VideoSite[] = [];
  const failed: Array<{ platform: string; error: string }> = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const v = s.value;
      if (v.ok) {
        allResults.push(...v.results);
        succeeded.push(v.site);
      } else {
        failed.push({ platform: v.site, error: v.error ?? 'unknown' });
      }
    } else {
      failed.push({ platform: 'unknown', error: String(s.reason) });
    }
  }
  return {
    results: allResults,
    stats: {
      requested_platforms: sites as string[],
      succeeded,
      failed,
    },
  };
}