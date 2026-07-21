import { describe, it, expect } from 'vitest';
import { VIDEO_SITES, DEFAULT_PLATFORMS, isVideoSite, ALL_PLATFORMS } from './video-types.js';

describe('video-types', () => {
  it('VIDEO_SITES has exactly 8 entries', () => {
    expect(VIDEO_SITES).toHaveLength(8);
    expect(new Set(VIDEO_SITES).size).toBe(8);
  });

  it('VIDEO_SITES contains the expected sites', () => {
    expect(VIDEO_SITES).toEqual(
      expect.arrayContaining(['bilibili', 'youtube', 'douyin', 'tiktok',
                              'instagram', 'xiaohongshu', 'weibo', 'twitter']),
    );
  });

  it('DEFAULT_PLATFORMS is bilibili, youtube, douyin', () => {
    expect(DEFAULT_PLATFORMS).toEqual(['bilibili', 'youtube', 'douyin']);
  });

  it('isVideoSite returns true for known sites and false for unknown', () => {
    expect(isVideoSite('bilibili')).toBe(true);
    expect(isVideoSite('all')).toBe(false);
    expect(isVideoSite('reddit')).toBe(false);
  });

  it('ALL_PLATFORMS is a sentinel string for video_search platform="all"', () => {
    expect(ALL_PLATFORMS).toBe('all');
  });
});