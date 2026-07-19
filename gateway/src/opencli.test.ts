import { describe, it, expect } from 'vitest';
import { buildArgs, buildRawArgs, parseResult } from './opencli.js';
import type { CmdRecord } from './manifest.js';

const search: CmdRecord = {
  site: 'bilibili', name: 'search', description: '', access: 'read',
  args: [
    { name: 'keyword', type: 'str', required: true, positional: true },
    { name: 'limit', type: 'int', required: false, positional: false },
    { name: 'verbose', type: 'boolean', required: false, positional: false },
  ],
};

describe('buildArgs', () => {
  it('orders positionals first, then flags, then --format json', () => {
    expect(buildArgs(search, { keyword: '恐怖黎明', limit: 5 }))
      .toEqual(['恐怖黎明', '--limit', '5', '--format', 'json']);
  });

  it('boolean true becomes bare flag, false omitted', () => {
    expect(buildArgs(search, { keyword: 'x', verbose: true }))
      .toEqual(['x', '--verbose', '--format', 'json']);
    expect(buildArgs(search, { keyword: 'x', verbose: false }))
      .toEqual(['x', '--format', 'json']);
  });

  it('throws on missing required', () => {
    expect(() => buildArgs(search, { limit: 3 })).toThrow('missing required arg: keyword');
  });
});

describe('buildRawArgs', () => {
  it('uses _ as positionals and rest as flags, hasSession=false', () => {
    expect(buildRawArgs({ _: ['http://x'], depth: 2, full: true, off: false }))
      .toEqual({ positionals: ['http://x'], flags: ['--depth', '2', '--full'], hasSession: false });
  });

  it('browser-style: session + url as positionals, rest as flags, hasSession=true', () => {
    expect(buildRawArgs({ session: 'work', _: ['https://x.com'], window: 'background' }))
      .toEqual({ positionals: ['work', 'https://x.com'], flags: ['--window', 'background'], hasSession: true });
  });

  it('browser-style with only session positional', () => {
    expect(buildRawArgs({ session: 'work' }))
      .toEqual({ positionals: ['work'], flags: [], hasSession: true });
  });

  it('boolean false is omitted, true becomes bare flag', () => {
    expect(buildRawArgs({ _: ['x'], verbose: true, quiet: false }))
      .toEqual({ positionals: ['x'], flags: ['--verbose'], hasSession: false });
  });
});

describe('parseResult', () => {
  it('parses JSON stdout on exit 0', () => {
    expect(parseResult(0, '{"rows":[1,2]}', '')).toEqual({ ok: true, data: { rows: [1, 2] } });
  });
  it('returns stderr on nonzero exit when no envelope', () => {
    expect(parseResult(1, '', 'boom')).toEqual({ ok: false, stderr: 'boom', data: undefined });
  });
  it('parses stderr JSON envelope on nonzero exit', () => {
    const env = '{"ok":false,"error":{"code":"AUTH_REQUIRED","message":"login"},"exitCode":77}';
    expect(parseResult(77, '', env)).toMatchObject({
      ok: false,
      data: { ok: false, error: { code: 'AUTH_REQUIRED', message: 'login' }, exitCode: 77 },
    });
  });
  it('rescues AUTH_REQUIRED envelope when stderr is prefixed with [UNDICI-EHPA]', () => {
    // The Node 22+ undici experimental proxy agent writes this warning to
    // stderr BEFORE the adapter's YAML envelope, breaking parseLooseEnvelope's
    // `startsWith('ok:')` guard. Verifies parseResult falls back to
    // rescueEnvelope() and surfaces vncUrl-eligible fields.
    const stderr = [
      '(node:2579) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      'ok: false',
      'error:',
      '  code: AUTH_REQUIRED',
      '  message: dianping search "火锅" requires login',
      '  help: Please open Chrome or Chromium and log in to https://dianping.com',
      'exitCode: 77',
    ].join('\n');
    expect(parseResult(77, '', stderr)).toMatchObject({
      ok: false,
      data: {
        error: {
          code: 'AUTH_REQUIRED',
          message: 'dianping search "火锅" requires login',
          help: 'Please open Chrome or Chromium and log in to https://dianping.com',
        },
      },
    });
  });
  it('parses YAML-style opencli envelope even on exit 0', () => {
    const env = [
      'ok: false',
      'error:',
      '  code: AUTH_REQUIRED',
      '  message: login required',
      '  help: Please log in to https://www.xiaohongshu.com',
      'exitCode: 77',
    ].join('\n');
    expect(parseResult(0, env, '')).toEqual({
      ok: false,
      data: {
        ok: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'login required',
          help: 'Please log in to https://www.xiaohongshu.com',
        },
        exitCode: 77,
      },
      stderr: '',
    });
  });
  it('parses YAML envelope with ok: true', () => {
    const env = 'ok: true\nrows: [1,2]\nexitCode: 0';
    expect(parseResult(0, env, '')).toEqual({ ok: true, data: { ok: true, rows: '[1,2]', exitCode: 0 }, stderr: '' });
  });
  it('returns error when stdout not parseable', () => {
    const r = parseResult(0, 'not json', '');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('non-JSON');
  });
  it('wraps raw base64 PNG stdout (opencli browser screenshot) into {data, mimeType}', () => {
    // mimic the bug: opencli's `browser screenshot` (no --path) writes the
    // raw base64 to stdout, breaking --format json. See report
    // C:\Users\32115\camfox-opencli-test-report.md §3.6.4.
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const r = parseResult(0, pngB64, '');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ mimeType: 'image/png', format: 'png' });
    expect((r.data as { data: string }).data).toBe(pngB64);
  });
  it('wraps raw base64 JPEG stdout', () => {
    const jpgB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQAAAAAAAAAAAwQCAwUGAQcIChAAAAAFAwQBAQEAAAAAAAAAAAAAAAQIDBAUGByH/2gAMAwEAAhADEAAAAVNP4HOP/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=';
    const r = parseResult(0, jpgB64, '');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ mimeType: 'image/jpeg', format: 'jpeg' });
  });
  it('does NOT treat arbitrary JSON-shaped strings as screenshots', () => {
    // ensure we don't shadow real JSON stdout
    const r = parseResult(0, '{"screenshot":"iVBORw0KGgoAAAA"}', '');
    expect(r.ok).toBe(true);
    expect((r.data as { screenshot: string }).screenshot).toBe('iVBORw0KGgoAAAA');
  });
});
