import type { ErrorCode } from './video-types.js';

export type DispatchMethod = 'native' | 'ytdlp';

export interface DispatchResult {
  method: DispatchMethod;
  site?: string;
  args: string[];
  error?: { code: ErrorCode; message: string };
}

const BV_RE = /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})/i;

function bilibili(url: URL): DispatchResult | null {
  if (url.hostname.endsWith('bilibili.com')) {
    const m = BV_RE.exec(url.pathname);
    if (m) return { method: 'native', site: 'bilibili', args: ['--bvid', m[1]] };
    return null;
  }
  if (url.hostname === 'b23.tv' || url.hostname.endsWith('.b23.tv')) {
    return { method: 'native', site: 'bilibili', args: ['--url', url.toString()] };
  }
  return null;
}

function instagram(url: URL): DispatchResult | null {
  if (!url.hostname.endsWith('instagram.com')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  if (!['p', 'reel', 'tv'].includes(kind)) return null;
  if (!parts[1]) return null;
  const canonical = `https://www.instagram.com/${kind}/${parts[1]}/`;
  return { method: 'native', site: 'instagram', args: ['--url', canonical] };
}

export function dispatch(rawUrl: string): DispatchResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { method: 'ytdlp', args: [rawUrl], error: { code: 'INVALID_URL', message: `Invalid URL: ${rawUrl}` } };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { method: 'ytdlp', args: [rawUrl], error: { code: 'INVALID_URL', message: `Unsupported protocol: ${url.protocol}` } };
  }
  const bili = bilibili(url);
  if (bili) return bili;
  const ig = instagram(url);
  if (ig) return ig;
  return { method: 'ytdlp', args: [url.toString()] };
}