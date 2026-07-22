import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { buildAbsoluteUrl } from '../src/video/url-builder.js';

function mockReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('buildAbsoluteUrl', () => {
  it('uses X-Forwarded-Host when present', () => {
    const url = buildAbsoluteUrl(mockReq({
      'x-forwarded-host': 'textvision.top',
      'x-forwarded-proto': 'https',
      'host': 'localhost:8080',
    }), '/files/abc.mp4');
    expect(url).toBe('https://textvision.top/files/abc.mp4');
  });

  it('uses X-Forwarded-Port when present', () => {
    const url = buildAbsoluteUrl(mockReq({
      'x-forwarded-host': 'textvision.top',
      'x-forwarded-port': '9378',
      'x-forwarded-proto': 'https',
    }), '/files/abc.mp4');
    expect(url).toBe('https://textvision.top:9378/files/abc.mp4');
  });

  it('falls back to Host header', () => {
    const url = buildAbsoluteUrl(mockReq({
      'host': 'localhost:8080',
    }), '/files/abc.mp4');
    expect(url).toBe('http://localhost:8080/files/abc.mp4');
  });

  it('falls back to http when no X-Forwarded-Proto', () => {
    const url = buildAbsoluteUrl(mockReq({ 'host': 'x:8080' }), '/files/y.mp4');
    expect(url).toBe('http://x:8080/files/y.mp4');
  });

  it('handles comma-separated X-Forwarded-Host taking the first', () => {
    const url = buildAbsoluteUrl(mockReq({
      'x-forwarded-host': 'first.example.com, second.example.com',
      'host': 'fallback',
    }), '/p');
    expect(url).toBe('http://first.example.com/p');
  });

  it('returns null when no host info at all', () => {
    const url = buildAbsoluteUrl(mockReq({}), '/files/x.mp4');
    expect(url).toBeNull();
  });
});