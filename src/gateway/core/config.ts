export interface Config {
  port: number;
  apiKey: string | null;
  opencliBin: string;
  manifestPath: string;
  camofoxUrl: string;
  camofoxApiKey: string | null;
  camofoxUserId: string;
  /** External hostname (and optional port) for VNC URLs returned to
   *  clients. Falls back to camofoxUrl's hostname or request Host header. */
  publicVncHost: string | null;
  /** Directory for cookie files, downloaded videos, etc.
   *  Defaults to /tmp because the gateway process's cwd is unreliable under
   *  supervisord (no `directory=` set) and `./tmp` would resolve to `/tmp`
   *  only by accident. Override with GATEWAY_TMP_DIR. */
  tmpDir: string;
  /** Directory for short-lived cookie staging files (one Netscape-formatted
   *  blob per video_download call, consumed by yt-dlp via `--cookies`).
   *  Defaults to /tmp. */
  cookieDir: string;
  /** Directory yt-dlp writes downloaded videos into. Independent from
   *  cookieDir so a host bind-mount on this path doesn't expose cookies. */
  outputDir: string;
  /** Directory for the JSONL gateway log file. */
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Optional HTTP/HTTPS proxy passed to yt-dlp (`--proxy`) so video
   *  downloads exit via v2raya instead of the bare container IP. Host and
   *  port are read from PROXY_HOST / PROXY_PORT (matching the variables
   *  already declared in docker-compose.yml for Camofox's fingerprint
   *  proxy layer). Empty / unset ⇒ no proxy flag is added to yt-dlp. */
  proxyUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: Number(env.GATEWAY_PORT) || 8080,
    apiKey: env.GATEWAY_API_KEY?.trim() || null,
    opencliBin: env.OPENCLI_BIN?.trim() || 'opencli',
    manifestPath: env.OPENCLI_MANIFEST?.trim() || '/opt/opencli/cli-manifest.json',
    camofoxUrl: (env.CAMOFOX_URL?.trim() || 'http://localhost:9377').replace(/\/$/, ''),
    camofoxApiKey: env.CAMOFOX_API_KEY?.trim() || null,
    camofoxUserId: env.CAMOFOX_USER_ID?.trim() || 'default',
    publicVncHost: env.PUBLIC_VNC_HOST?.trim() || env.PUBLIC_HOST?.trim() || null,
    tmpDir: env.GATEWAY_TMP_DIR?.trim() || '/tmp',
    cookieDir: env.GATEWAY_COOKIE_DIR?.trim() || '/opt/gateway/cookies',
    outputDir: env.GATEWAY_OUTPUT_DIR?.trim() || '/opt/gateway/tmp',
    logDir: env.GATEWAY_LOG_DIR?.trim() || '/var/log/gateway',
    logLevel: (env.GATEWAY_LOG_LEVEL?.trim() as 'debug' | 'info' | 'warn' | 'error') || 'info',
    proxyUrl: buildProxyUrl(env.PROXY_HOST, env.PROXY_PORT),
  };
}

function buildProxyUrl(host: string | undefined, port: string | undefined): string | null {
  const h = host?.trim();
  const p = port?.trim();
  if (!h) return null;
  // Strip an existing scheme so we don't end up with `http://http://...`.
  const bare = h.replace(/^[a-z]+:\/\//i, '');
  return `http://${bare}${p ? `:${p}` : ''}`;
}
