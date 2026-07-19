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
  };
}
