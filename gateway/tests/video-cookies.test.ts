import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportCookiesForHost } from '../src/video/video-cookies.js';

describe('exportCookiesForHost', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cookies-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a Netscape-format cookie file filtered to target host', async () => {
    const fetchCookies = vi.fn().mockResolvedValue([
      { domain: '.bilibili.com', name: 'SESSDATA', value: 'abc', httpOnly: true, secure: false, path: '/', expires: 0 },
      { domain: 'www.bilibili.com', name: 'uid', value: '123', httpOnly: false, secure: false, path: '/', expires: 0 },
      { domain: '.youtube.com', name: 'VISITOR', value: 'x', httpOnly: false, secure: false, path: '/', expires: 0 },
    ]);
    const result = await exportCookiesForHost('www.bilibili.com', {
      tmpDir,
      fetchCookies,
    });
    expect(result.cookieCount).toBe(2);
    expect(result.cookieFilePath).toContain('camofox_cookies_www.bilibili.com.txt');
    const content = await fs.readFile(result.cookieFilePath, 'utf8');
    expect(content).toContain('SESSDATA');
    expect(content).toContain('uid');
    expect(content).not.toContain('VISITOR');
    expect(content.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    const sessLine = content.split('\n').find((l) => l.includes('SESSDATA'))!;
    expect(sessLine.split('\t')[1]).toBe('TRUE');
  });

  it('returns empty file and error when fetchCookies throws', async () => {
    const fetchCookies = vi.fn().mockRejectedValue(new Error('network'));
    const result = await exportCookiesForHost('www.bilibili.com', {
      tmpDir,
      fetchCookies,
    });
    expect(result.cookieCount).toBe(0);
    expect(result.error?.code).toBe('COOKIE_FETCH_FAILED');
  });
});