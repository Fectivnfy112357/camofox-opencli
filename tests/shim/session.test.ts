import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the mock factory for camofox-client BEFORE importing session.
vi.mock('../../src/shim/camofox-client.js', () => ({
  createTab: vi.fn(async (uid: string) => ({
    tabId: `tab-${uid}-${Math.random().toString(36).slice(2, 8)}`,
    url: 'about:blank',
  })),
  navigate: vi.fn(async () => ({ ok: true })),
  closeTab: vi.fn(async () => {}),
  listTabs: vi.fn(async () => ({ tabs: [] })),
}));

import * as session from '../../src/shim/session.js';
import * as camofox from '../../src/shim/camofox-client.js';

const mockedCreate = camofox.createTab as unknown as ReturnType<typeof vi.fn>;
const mockedClose = camofox.closeTab as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  session.__resetForTests();
  mockedCreate.mockClear();
  mockedClose.mockClear();
});

describe('session.ensureTab', () => {
  it('returns the same mapping for the same sessionId (idempotent)', async () => {
    const a = await session.ensureTab('kimi');
    const b = await session.ensureTab('kimi');
    expect(b.tabId).toBe(a.tabId);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it('creates a new tab when userId differs', async () => {
    const a = await session.ensureTab('kimi', 'alice');
    const b = await session.ensureTab('kimi', 'bob');
    expect(b.tabId).not.toBe(a.tabId);
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it('updates lastUsedAt on every ensureTab call', async () => {
    const a = await session.ensureTab('kimi');
    const first = a.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    const b = await session.ensureTab('kimi');
    expect(b.lastUsedAt!).toBeGreaterThan(first!);
  });
});

describe('session LRU eviction', () => {
  it('evicts the least-recently-touched entry when MAX_SESSIONS exceeded', async () => {
    // Lower the cap for this test by mutating state: easiest is to fill beyond 8.
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const m = await session.ensureTab(`s-${i}`);
      ids.push(m.tabId);
      // ensure later entries have strictly later lastUsedAt by sleeping 1ms
      await new Promise((r) => setTimeout(r, 1));
    }
    // The very first session (`s-0`) should have been evicted because we
    // exceeded the default MAX_SESSIONS=8.
    expect(session.listAllTabs().some((t) => t.tabId === ids[0])).toBe(false);
    // And we closed that tab via camofox.closeTab.
    const closedTabIds = mockedClose.mock.calls.map(([tabId]) => tabId);
    expect(closedTabIds).toContain(ids[0]);
    // Eviction counter incremented.
    expect(session.stats().evictionsLru).toBeGreaterThanOrEqual(1);
  });
});

describe('session TTL eviction', () => {
  it('drops entries untouched beyond SESSION_TTL_MS on next ensureTab', async () => {
    // First create one entry.
    const a = await session.ensureTab('ancient');
    // Backdate lastUsedAt past the TTL window.
    const m = session.getSession('ancient')!;
    m.lastUsedAt = Date.now() - 31 * 60_000; // 31 min ago, TTL=30min
    await session.ensureTab('fresh');
    expect(session.listAllTabs().some((t) => t.tabId === a.tabId)).toBe(false);
    expect(session.stats().evictionsTtl).toBeGreaterThanOrEqual(1);
  });
});

describe('session.restoreFromLastUrl', () => {
  it('best-effort closes the dead tab and rebuilds the mapping', async () => {
    const orig = await session.ensureTab('kimi');
    // Simulate "dead" mapping by clearing it locally, then triggering restore.
    const deadTabId = orig.tabId;
    const fresh = await session.restoreFromLastUrl('kimi');
    expect(fresh.tabId).not.toBe(deadTabId);
    expect(mockedClose).toHaveBeenCalledWith(deadTabId, expect.any(String));
  });
});

describe('session.closeSession', () => {
  it('removes the mapping and closes the camofox tab', async () => {
    const a = await session.ensureTab('kimi');
    await session.closeSession('kimi');
    expect(mockedClose).toHaveBeenCalledWith(a.tabId, a.userId);
    expect(session.getSession('kimi')).toBeUndefined();
  });
});

describe('session stats', () => {
  it('reports size/counters/limits', async () => {
    const before = session.stats();
    await session.ensureTab('s1');
    await session.ensureTab('s2');
    const after = session.stats();
    expect(after.size).toBe(before.size + 2);
    expect(after.max).toBeGreaterThanOrEqual(2);
    expect(after.ttlMs).toBeGreaterThan(0);
  });
});
