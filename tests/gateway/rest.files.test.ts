import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { createRestHandler } from '../../src/gateway/api/rest.js';
import { TempStore } from '../../src/gateway/video/temp-store.js';
import type { Config } from '../../src/gateway/core/config.js';
import type { Manifest } from '../../src/gateway/core/manifest.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('GET /files/:id', () => {
  let tmpDir: string;
  let tempStore: TempStore;
  let handler: ReturnType<typeof createRestHandler>;
  let writeHead: ReturnType<typeof vi.fn>;
  let end: ReturnType<typeof vi.fn>;
  let setHeader: ReturnType<typeof vi.fn>;
  let res: ServerResponse;
  let chunks: Buffer[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-files-'));
    tempStore = new TempStore({ tmpDir, ttlMs: 60 * 60 * 1000 });
    const cfg: Config = { apiKey: '', manifestPath: '', tmpDir, logDir: '/tmp', logLevel: 'info' };
    const manifest: Manifest = { getSiteHelp: vi.fn(), listSites: vi.fn(), searchSites: vi.fn() } as unknown as Manifest;
    handler = createRestHandler({ cfg, manifest, tempStore, run: vi.fn(), vnc: vi.fn() });
    writeHead = vi.fn();
    end = vi.fn();
    setHeader = vi.fn();
    chunks = [];
    const writable = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    // Track end calls without overriding the Writable's own .end() method,
    // which Node's pipe() relies on to signal "no more writes".
    const origEnd = writable.end.bind(writable);
    writable.end = ((...args: any[]) => {
      end();
      return (origEnd as any)(...args);
    }) as any;
    res = Object.assign(writable, { setHeader, writeHead }) as unknown as ServerResponse;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockReq(method: string, url: string): IncomingMessage {
    return { method, url, headers: { host: 'localhost:8080' } } as unknown as IncomingMessage;
  }

  it('streams the registered file with attachment header', async () => {
    const file = path.join(tmpDir, 'BV1.mp4');
    await fs.writeFile(file, 'video-bytes');
    const { id } = await tempStore.register(file);
    await handler(mockReq('GET', `/files/${id}.mp4`), res);
    expect(writeHead).toHaveBeenCalledWith(200);
    expect(setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('attachment'));
    expect(setHeader).toHaveBeenCalledWith('Content-Type', expect.stringMatching(/video|octet-stream/));
    // Wait for the pipe to finish (Node calls res.end() automatically).
    await new Promise<void>((resolve) => res.on('finish', () => resolve()));
    expect(end).toHaveBeenCalled();
    expect(Buffer.concat(chunks).toString()).toBe('video-bytes');
  });

  it('returns 404 for unknown id', async () => {
    let body = '';
    const origEnd = res.end.bind(res);
    (res as any).end = (chunk: any, ...rest: any[]) => {
      if (chunk) body += String(chunk);
      return (origEnd as any)(chunk, ...rest);
    };
    await handler(mockReq('GET', '/files/00000000-0000-0000-0000-000000000000.mp4'), res);
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(JSON.parse(body).ok).toBe(false);
  });

  it('requires GET method (405 for POST)', async () => {
    let body = '';
    const origEnd = res.end.bind(res);
    (res as any).end = (chunk: any, ...rest: any[]) => {
      if (chunk) body += String(chunk);
      return (origEnd as any)(chunk, ...rest);
    };
    const file = path.join(tmpDir, 'a.mp4');
    await fs.writeFile(file, 'x');
    const { id } = await tempStore.register(file);
    await handler(mockReq('POST', `/files/${id}.mp4`), res);
    expect(writeHead).toHaveBeenCalledWith(405);
    expect(JSON.parse(body).ok).toBe(false);
  });
});