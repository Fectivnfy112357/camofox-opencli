import { describe, it, expect, vi } from 'vitest';
import { searchVideos } from '../../src/gateway/video/video-router.js';
import { VIDEO_SITES, DEFAULT_PLATFORMS } from '../../src/gateway/video/video-types.js';

describe('searchVideos', () => {
  it('rejects empty query', async () => {
    await expect(searchVideos({ query: '   ' }, { runOpencli: vi.fn() })).rejects.toThrow('EMPTY_QUERY');
  });

  it('rejects unknown platform', async () => {
    await expect(
      searchVideos({ query: 'x', platform: 'reddit' }, { runOpencli: vi.fn() }),
    ).rejects.toThrow('INVALID_PLATFORM');
  });

  it('uses DEFAULT_PLATFORMS when platform is omitted', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0, stdout: JSON.stringify([{ id: 'BV1', title: 't', url: 'u' }]), stderr: '',
    });
    const res = await searchVideos({ query: 'cat' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledTimes(DEFAULT_PLATFORMS.length);
    expect(res.stats.requested_platforms).toEqual([...DEFAULT_PLATFORMS]);
    expect(res.results).toHaveLength(DEFAULT_PLATFORMS.length);
  });

  it('expands platform=all to all VIDEO_SITES', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0, stdout: '[]', stderr: '',
    });
    const res = await searchVideos({ query: 'x', platform: 'all' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledTimes(VIDEO_SITES.length);
    expect(res.stats.requested_platforms).toEqual([...VIDEO_SITES]);
  });

  it('handles single named platform', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0, stdout: '[]', stderr: '',
    });
    const res = await searchVideos({ query: 'x', platform: 'bilibili' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledTimes(1);
    expect(res.stats.requested_platforms).toEqual(['bilibili']);
  });

  it('records per-site failures in stats.failed without aborting', async () => {
    const runOpencli = vi.fn().mockImplementation(async (site: string) => {
      if (site === 'youtube') return { ok: false, exitCode: 1, stdout: '', stderr: 'AUTH_REQUIRED' };
      return { ok: true, exitCode: 0, stdout: JSON.stringify([{ id: 'X', title: 't', url: 'u' }]), stderr: '' };
    });
    const res = await searchVideos({ query: 'x' }, { runOpencli });
    expect(res.results).toHaveLength(2); // bilibili + tiktok each contribute 1 row
    expect(res.stats.failed).toEqual([{ platform: 'youtube', error: 'AUTH_REQUIRED' }]);
    expect(res.stats.succeeded).toEqual(['bilibili', 'tiktok']);
  });

  it('clamps limit to [1, 30] with default 10', async () => {
    const runOpencli = vi.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: '[]', stderr: '' });
    await searchVideos({ query: 'x', limit: 999 }, { runOpencli });
    // First 3 calls (default platforms) from limit=999 → all clamped to 30
    expect(runOpencli.mock.calls[0][2]).toEqual(expect.arrayContaining(['--limit', '30']));
    await searchVideos({ query: 'x' }, { runOpencli });
    // Calls 3..5 from the second search with no limit → defaults to 10
    expect(runOpencli.mock.calls[3][2]).toEqual(expect.arrayContaining(['--limit', '10']));
  });

  // Regression for the twitter 0-row bug: twitter adapter emits
  // { id, author, bio, text, created_at, likes, views, url, ... }
  // (per OpenCLI/clis/twitter/search.js:tweetToRow). The original mapRow
  // only looked at title/desc/name and dropped every twitter row.
  it('maps twitter-shaped rows (text as title) and preserves likes/views/url', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0,
      stdout: JSON.stringify([{
        id: '2084106804032872591',
        author: 'MiniMax_AI',
        bio: '',
        text: 'MiniMax-H3 Is Now Publicly Available https://t.co/x24nyGoKt8',
        created_at: 'Mon Aug 03 02:39:17 +0000 2026',
        likes: 4701,
        views: '1698153',
        url: 'https://x.com/i/status/2084106804032872591',
        has_media: true,
        media_urls: ['https://video.twimg.com/.../mp4'],
        media_posters: ['https://pbs.twimg.com/.../jpg'],
        card: null,
        quoted_tweet: null,
      }]),
      stderr: '',
    });
    const res = await searchVideos({ query: 'minimax', platform: 'twitter' }, { runOpencli });
    expect(res.stats.succeeded).toEqual(['twitter']);
    expect(res.results).toHaveLength(1);
    const r = res.results[0];
    expect(r.platform).toBe('twitter');
    expect(r.id).toBe('2084106804032872591');
    expect(r.title).toContain('MiniMax-H3');
    expect(r.title).toContain('Publicly Available');
    expect(r.url).toBe('https://x.com/i/status/2084106804032872591');
    expect(r.author).toBe('MiniMax_AI');
    // views comes back as a string from the adapter; mapRow must accept that
    // without throwing and propagate it as-is.
    expect(r.views).toBe('1698153');
  });

  // Regression for the instagram video_search bug. Instagram's `search` command
  // only matches user accounts (topsearch?context=user), so video_search now
  // routes instagram to `explore` (the discover grid), whose rows look like
  // { rank, user, caption, likes, comments, type }. The earlier mapRow did
  // not understand `caption` (so titles were empty → row dropped) and did
  // not filter out `type: 'photo'`, so the response was always empty or
  // polluted with non-video posts.
  it('routes instagram through the explore command and maps caption/type/url', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0,
      stdout: JSON.stringify([
        {
          rank: 1,
          user: 'somecreator',
          caption: 'A sunset reel from yesterday',
          likes: 1234,
          comments: 56,
          type: 'video',
          code: 'CxYz1234',
          pk: '9876543210',
        },
      ]),
      stderr: '',
    });
    const res = await searchVideos({ query: 'sunset', platform: 'instagram', limit: 5 }, { runOpencli });
    // The command should be `explore`, not `search`, and query should NOT be
    // forwarded (instagram's public API has no keyword-video search).
    expect(runOpencli).toHaveBeenCalledWith('instagram', 'explore', ['--format', 'json', '--limit', '5']);
    expect(res.stats.succeeded).toEqual(['instagram']);
    expect(res.results).toHaveLength(1);
    const r = res.results[0];
    expect(r.platform).toBe('instagram');
    expect(r.title).toBe('A sunset reel from yesterday');
    expect(r.author).toBe('somecreator');
    // The id fallback chain tries code/pk/rank; `code` wins here.
    expect(r.id).toBe('CxYz1234');
  });

  it('filters out instagram explore rows whose type is photo', async () => {
    const runOpencli = vi.fn().mockResolvedValue({
      ok: true, exitCode: 0,
      stdout: JSON.stringify([
        { rank: 1, user: 'a', caption: 'a photo post', likes: 10, comments: 1, type: 'photo' },
        { rank: 2, user: 'b', caption: 'a video post', likes: 20, comments: 2, type: 'video' },
        { rank: 3, user: 'c', caption: 'a carousel', likes: 30, comments: 3, type: 'carousel' },
      ]),
      stderr: '',
    });
    const res = await searchVideos({ query: 'x', platform: 'instagram' }, { runOpencli });
    // Photo is dropped, video and carousel survive.
    expect(res.results.map((r) => r.author)).toEqual(['b', 'c']);
  });

  it('keeps forwarding query for non-instagram sites', async () => {
    const runOpencli = vi.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: '[]', stderr: '' });
    await searchVideos({ query: '周杰伦', platform: 'bilibili' }, { runOpencli });
    expect(runOpencli).toHaveBeenCalledWith('bilibili', 'search', ['周杰伦', '--format', 'json', '--limit', '10']);
  });
});