export type ErrorCode =
  | 'INVALID_URL'
  | 'URLS_TOO_MANY'
  | 'NATIVE_DOWNLOAD_FAILED'
  | 'YT_DLP_FAILED'
  | 'COOKIE_FETCH_FAILED'
  | 'LOGIN_REQUIRED'
  | 'PAID_CONTENT'
  | 'RATE_LIMITED'
  | 'WORKER_TIMEOUT'
  | 'DISK_FULL'
  | 'CAMOFOX_DOWNLOAD_FAILED';

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