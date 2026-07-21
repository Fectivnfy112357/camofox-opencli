import { describe, it, expect } from 'vitest';
import { dispatch } from './native-dispatcher.js';

describe('native-dispatcher', () => {
  it('routes bilibili BV URLs to native download', () => {
    const r = dispatch('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(r.method).toBe('native');
    expect(r.site).toBe('bilibili');
    expect(r.args).toEqual(expect.arrayContaining(['--bvid', 'BV1xx411c7mD']));
  });

  it('routes bilibili short links (b23.tv) to native download', () => {
    const r = dispatch('https://b23.tv/abc123');
    expect(r.method).toBe('native');
    expect(r.site).toBe('bilibili');
  });

  it('routes instagram /p/ to native download', () => {
    const r = dispatch('https://www.instagram.com/p/ABC123/');
    expect(r.method).toBe('native');
    expect(r.site).toBe('instagram');
    expect(r.args).toEqual(['--url', 'https://www.instagram.com/p/ABC123/']);
  });

  it('routes instagram /reel/ to native download', () => {
    const r = dispatch('https://www.instagram.com/reel/ABC123/?utm_source=ig_web_copy_link');
    expect(r.method).toBe('native');
    expect(r.site).toBe('instagram');
  });

  it('routes youtube URLs to ytdlp', () => {
    const r = dispatch('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.method).toBe('ytdlp');
  });

  it('routes youtu.be short URLs to ytdlp', () => {
    const r = dispatch('https://youtu.be/dQw4w9WgXcQ');
    expect(r.method).toBe('ytdlp');
  });

  it('routes unknown hosts to ytdlp fallback', () => {
    const r = dispatch('https://vimeo.com/12345');
    expect(r.method).toBe('ytdlp');
  });

  it('returns INVALID_URL for non-http schemes', () => {
    const r = dispatch('ftp://example.com/video.mp4');
    expect(r.method).toBe('ytdlp');
    expect(r.error?.code).toBe('INVALID_URL');
  });

  it('returns INVALID_URL for malformed URLs', () => {
    const r = dispatch('not a url');
    expect(r.error?.code).toBe('INVALID_URL');
  });
});