import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.apiKey).toBeNull();
    expect(c.opencliBin).toBe('opencli');
    expect(c.manifestPath).toBe('/opt/opencli/cli-manifest.json');
    expect(c.camofoxUserId).toBe('default');
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      GATEWAY_PORT: '9090',
      GATEWAY_API_KEY: 'secret',
      OPENCLI_BIN: '/usr/local/bin/opencli',
      CAMOFOX_USER_ID: 'fectivnfy',
      PUBLIC_VNC_HOST: 'camofox.example.com:6080',
    });
    expect(c.port).toBe(9090);
    expect(c.apiKey).toBe('secret');
    expect(c.opencliBin).toBe('/usr/local/bin/opencli');
    expect(c.camofoxUserId).toBe('fectivnfy');
    expect(c.publicVncHost).toBe('camofox.example.com:6080');
  });

  it('publicVncHost falls back to PUBLIC_HOST alias then null', () => {
    expect(loadConfig({ PUBLIC_HOST: 'a.example' }).publicVncHost).toBe('a.example');
    expect(loadConfig({}).publicVncHost).toBeNull();
  });
});
