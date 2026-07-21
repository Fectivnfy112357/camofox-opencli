import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TempStore } from './temp-store.js';

describe('TempStore', () => {
  let dir: string;
  let store: TempStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-tempstore-'));
    store = new TempStore({ tmpDir: dir, ttlMs: 60 * 60 * 1000 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('register returns an id and exposes the file', async () => {
    const file = path.join(dir, 'BV1.mp4');
    await fs.writeFile(file, 'hello');
    const { id } = await store.register(file);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const found = store.get(id);
    expect(found?.path).toBe(file);
    expect(found?.filename).toBe('BV1.mp4');
    expect(found?.size_bytes).toBe(5);
  });

  it('get returns undefined for unknown id', () => {
    expect(store.get('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('sweep removes only files older than ttl and only matches video_*', async () => {
    const old = path.join(dir, 'video_old.mp4');
    const fresh = path.join(dir, 'video_fresh.mp4');
    const unrelated = path.join(dir, 'gateway.log');
    await fs.writeFile(old, 'old');
    await fs.writeFile(fresh, 'fresh');
    await fs.writeFile(unrelated, 'log');
    const past = Date.now() / 1000 - 7200;
    await fs.utimes(old, past, past);
    const removed = await store.sweep();
    expect(removed).toBe(1);
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
  });
});