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
    expect(res.results).toHaveLength(2); // bilibili + douyin each contribute 1 row
    expect(res.stats.failed).toEqual([{ platform: 'youtube', error: 'AUTH_REQUIRED' }]);
    expect(res.stats.succeeded).toEqual(['bilibili', 'douyin']);
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
});