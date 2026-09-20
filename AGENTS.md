# Video download: Bilibili transport

Apply this rule when changing or debugging `video_download` / `DownloadPool` for Bilibili URLs.

- Route the yt-dlp download path through `yt-dlp-curl-cffi`; this launcher removes yt-dlp's `UrllibRH`, so the endpoint uses `curl_cffi` without urllib fallback.
- For Bilibili only, do **not** add `--impersonate chrome`. With the configured v2raya proxy, `curl_cffi` without impersonation returns playable DASH streams; Chrome impersonation can return HTTP 200 / API `code: 0` with empty `dash.video` and `dash.audio` lists.
- Before invoking yt-dlp, remove Bilibili share attribution query fields (`spm_id_from`, `vd_source`, and the related `share_*` fields), while preserving functional parameters such as `p` for multipart videos.
- Treat `No video formats found` and HTTP 412 as transient Bilibili play-info failures: use the bounded fresh-process retry in `DownloadPool`, rather than switching the endpoint back to urllib.

Verification: run `npm test -- --run tests/gateway/download-pool.test.ts`, `npm run build`, then invoke `video_download` with a Bilibili share URL at `1080p`. Confirm the yt-dlp log says `Request Handlers: curl_cffi` and returns a non-empty downloaded file.
