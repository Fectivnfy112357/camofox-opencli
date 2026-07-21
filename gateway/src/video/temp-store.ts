import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TempStoreEntry {
  path: string;
  filename: string;
  size_bytes: number;
  created_at: number;
  expires_at: number;
}

export interface TempStoreOptions {
  tmpDir: string;
  ttlMs: number;
}

export class TempStore {
  private entries = new Map<string, TempStoreEntry>();

  constructor(private opts: TempStoreOptions) {}

  async register(absolutePath: string): Promise<{ id: string; expires_at: string }> {
    const stat = await fs.stat(absolutePath);
    const id = randomUUID();
    const expires_at = Date.now() + this.opts.ttlMs;
    this.entries.set(id, {
      path: absolutePath,
      filename: path.basename(absolutePath),
      size_bytes: stat.size,
      created_at: Date.now(),
      expires_at,
    });
    return { id, expires_at: new Date(expires_at).toISOString() };
  }

  get(id: string): TempStoreEntry | undefined {
    return this.entries.get(id);
  }

  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.opts.ttlMs;
    let removed = 0;
    // Remove expired registered entries first
    const entries = [...this.entries.entries()];
    for (const [id, entry] of entries) {
      if (entry.created_at > cutoff) continue;
      try {
        await fs.unlink(entry.path);
      } catch {
        // file already gone, just drop the entry
      }
      this.entries.delete(id);
      removed++;
    }
    // Scan filesystem for any unregistered ./tmp/video_* older than TTL
    let files: string[] = [];
    try {
      files = await fs.readdir(this.opts.tmpDir);
    } catch {
      return removed;
    }
    for (const f of files) {
      if (!f.startsWith('video_')) continue;
      const fullPath = path.join(this.opts.tmpDir, f);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs <= cutoff) {
          await fs.unlink(fullPath);
          removed++;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  }
}