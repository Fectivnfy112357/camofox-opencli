export const VIDEO_SITES = [
  'bilibili', 'youtube', 'douyin', 'tiktok',
  'instagram', 'xiaohongshu', 'weibo', 'twitter',
] as const;

export type VideoSite = typeof VIDEO_SITES[number];

export const DEFAULT_PLATFORMS: readonly VideoSite[] = ['bilibili', 'youtube', 'tiktok'];

export const ALL_PLATFORMS = 'all' as const;

export function isVideoSite(s: string): s is VideoSite {
  return (VIDEO_SITES as readonly string[]).includes(s);
}

export type ErrorCode =
  | 'INVALID_URL'
  | 'URLS_TOO_MANY'
  | 'EMPTY_QUERY'
  | 'INVALID_PLATFORM'
  | 'NATIVE_DOWNLOAD_FAILED'
  | 'YT_DLP_FAILED'
  | 'COOKIE_FETCH_FAILED'
  | 'LOGIN_REQUIRED'
  | 'PAID_CONTENT'
  | 'RATE_LIMITED'
  | 'WORKER_TIMEOUT'
  | 'DISK_FULL'
  | 'CAMOFOX_DOWNLOAD_FAILED';

export interface VideoSearchResult {
  platform: VideoSite;
  id: string;
  title: string;
  url: string;
  author?: string;
  duration?: string;
  views?: number;
  thumbnail?: string;
}

export interface VideoSearchResponse {
  results: VideoSearchResult[];
  stats: {
    requested_platforms: string[];
    succeeded: VideoSite[];
    failed: Array<{ platform: string; error: string }>;
  };
}

export interface VideoDownloadSuccess {
  url: string;
  ok: true;
  method: 'native' | 'ytdlp' | 'camofox';
  filename: string;
  size_bytes: number;
  download_url: string;
  expires_at: string;
}

export interface VideoDownloadFailure {
  url: string;
  ok: false;
  error_code: ErrorCode;
  error_message: string;
}

export type VideoDownloadResult = VideoDownloadSuccess | VideoDownloadFailure;
