import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/gateway/core/config.js';

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
    });
    expect(c.port).toBe(9090);
    expect(c.apiKey).toBe('secret');
    expect(c.opencliBin).toBe('/usr/local/bin/opencli');
    expect(c.camofoxUserId).toBe('fectivnfy');
  });

  it('defaults gateway data paths to $HOME/.camofox/gateway/* so a single bind-mount covers them', () => {
    // These are the default paths used when no GATEWAY_*_DIR env var is
    // set. They MUST all live under $HOME/.camofox/ so the single
    // ./data:/home/node/.camofox bind-mount in docker-compose.yml
    // covers gateway logs, video tmp files, and per-request cookie
    // staging without any extra volume wiring. If you change these
    // defaults, update docker-compose.yml, Dockerfile, and supervisord
    // .conf together — they form one contract.
    const expectedRoot = join(homedir(), '.camofox', 'gateway');
    const c = loadConfig({});
    expect(c.logDir).toBe(join(expectedRoot, 'log'));
    expect(c.outputDir).toBe(join(expectedRoot, 'tmp'));
    expect(c.cookieDir).toBe(join(expectedRoot, 'cookies'));
    expect(c.tmpDir).toBe(join(expectedRoot, 'tmp'));
  });

  it('honors GATEWAY_*_DIR env overrides', () => {
    const c = loadConfig({
      GATEWAY_LOG_DIR: '/custom/log',
      GATEWAY_OUTPUT_DIR: '/custom/out',
      GATEWAY_COOKIE_DIR: '/custom/cookies',
      GATEWAY_TMP_DIR: '/custom/tmp',
    });
    expect(c.logDir).toBe('/custom/log');
    expect(c.outputDir).toBe('/custom/out');
    expect(c.cookieDir).toBe('/custom/cookies');
    expect(c.tmpDir).toBe('/custom/tmp');
  });
});
