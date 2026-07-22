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
  /** Directory for the JSONL gateway log file. */
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
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
    logDir: env.GATEWAY_LOG_DIR?.trim() || '/var/log/gateway',
    logLevel: (env.GATEWAY_LOG_LEVEL?.trim() as 'debug' | 'info' | 'warn' | 'error') || 'info',
  };
}
