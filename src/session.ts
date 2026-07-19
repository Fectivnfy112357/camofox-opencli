/**
 * Session manager — maps OpenCLI session IDs to Camofox (userId, tabId) pairs,
 * with LRU + TTL eviction so abandoned sessions do not leak tabs into Camofox
 * (each leaked tab is a Firefox content process consuming CPU on heavy SPA
 * pages like kimi.com / kimi.com/pricing).
 */
import type { SessionMapping } from './types.js';
import * as camofox from './camofox-client.js';

const DEFAULT_USER_ID = process.env.CAMOFOX_USER_ID || 'fectivnfy';

/**
 * Cap on the in-memory session map. When exceeded, the least-recently-touched
 * entry is closed (DELETE /tabs/:id) before the new tab is added.
 *
 * Chosen to leave room for a small handful of concurrent sessions (default
 * OpenCLI profile + a couple of one-offs) without runaway growth.
 */
const MAX_SESSIONS = Number(process.env.SHIM_MAX_SESSIONS ?? 8);

/**
 * Idle TTL — a session untouched for this many ms is eligible for eviction.
 * Self-healing on next access will recreate the tab transparently.
 *
 * 30 min tracks Camofox's own IDLE_TIMEOUT so we evict close to the same
 * point the Camofox-side tab would have died anyway, but on our side cleanly.
 */
const SESSION_TTL_MS = Number(process.env.SHIM_SESSION_TTL_MS ?? 30 * 60_000);

const sessions = new Map<string, SessionMapping>();
let evictionsLru = 0;
let evictionsTtl = 0;
let lastEvictionAt: string | null = null;

function normalizeUserId(userId: string): string {
  return userId || DEFAULT_USER_ID;
}

function touch(m: SessionMapping): SessionMapping {
  m.lastUsedAt = Date.now();
  return m;
}

/**
 * Get or create a Camofox tab for an OpenCLI session.
 * Always returns a fresh tab — the `page` identity from OpenCLI is ignored
 * because Camofox tabId replaces CDP targetId.
 */
export async function ensureTab(
  sessionId: string,
  userId?: string,
): Promise<SessionMapping> {
  const uid = normalizeUserId(userId || '');

  // Reap any expired entries so they don't count against MAX_SESSIONS.
  evictExpired(uid);

  const existing = sessions.get(sessionId);
  if (existing && existing.userId === uid) {
    return touch(existing);
  }

  // Evict LRU (oldest lastUsedAt) until we're under the cap. Only evict
  // entries belonging to the same userId so multi-user shim deployments
  // don't cross-evict.
  await evictLruIfOverCap(uid);

  const tab = await camofox.createTab(uid, sessionId);
  const mapping: SessionMapping = {
    userId: uid,
    tabId: tab.tabId,
    lastUrl: tab.url,
    lastUsedAt: Date.now(),
  };
  sessions.set(sessionId, mapping);
  return mapping;
}

/**
 * Look up an existing session mapping and bump its lastUsedAt so it survives
 * the next reaper sweep.
 */
export function getSession(sessionId: string): SessionMapping | undefined {
  const m = sessions.get(sessionId);
  if (!m) return undefined;
  return touch(m);
}

function evictExpired(uid: string): void {
  const now = Date.now();
  for (const [id, m] of sessions) {
    if (m.userId !== uid) continue;
    if (now - (m.lastUsedAt ?? now) >= SESSION_TTL_MS) {
      sessions.delete(id);
      camofox.closeTab(m.tabId, m.userId).catch(() => {
        // Tab may already be closed; nothing we can do.
      });
      evictionsTtl++;
      lastEvictionAt = new Date().toISOString();
    }
  }
}

async function evictLruIfOverCap(uid: string): Promise<void> {
  // Only count entries for the target userId toward the cap.
  const sameUser = [...sessions.entries()].filter(([, m]) => m.userId === uid);
  while (sameUser.length >= MAX_SESSIONS) {
    sameUser.sort(([, a], [, b]) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
    const [victimId, victim] = sameUser.shift()!;
    sessions.delete(victimId);
    try {
      await camofox.closeTab(victim.tabId, victim.userId);
    } catch {
      // Ignore close failures — Camofox may have already reaped the tab.
    }
    evictionsLru++;
    lastEvictionAt = new Date().toISOString();
  }
}

/**
 * Self-healing hook called when a tab has been observed dead. Throws away
 * the stale mapping and recreates it from any recorded lastUrl (which acts
 * as a "return to where the user was" affordance after silent tab loss
 * from manual VNC login or IDLE_TIMEOUT). The orphan Camofox tab is closed
 * best-effort so it doesn't keep burning CPU on the old page.
 */
export async function restoreFromLastUrl(sessionId: string): Promise<SessionMapping> {
  const stale = sessions.get(sessionId);
  const lastUrl = stale?.lastUrl;
  if (stale) {
    // Best-effort close of the dead tab. ignore failures.
    camofox.closeTab(stale.tabId, stale.userId).catch(() => {});
    sessions.delete(sessionId);
  }
  const fresh = await ensureTab(sessionId);
  if (lastUrl) {
    try { await navigateSession(fresh, lastUrl); }
    catch { /* navigation may fail on locked-down landing pages; the new tab is alive either way */ }
  }
  return fresh;
}

/**
 * Navigate the tab and update the lastUrl.
 */
export async function navigateSession(
  mapping: SessionMapping,
  url: string,
): Promise<void> {
  await camofox.navigate(mapping.tabId, url);
  mapping.lastUrl = url;
  mapping.lastUsedAt = Date.now();
}

/**
 * Close the session's tab and remove the mapping.
 */
export async function closeSession(sessionId: string): Promise<void> {
  const mapping = sessions.get(sessionId);
  if (mapping) {
    try {
      await camofox.closeTab(mapping.tabId, mapping.userId);
    } catch {
      // Tab may already be closed
    }
    sessions.delete(sessionId);
  }
}

/**
 * Close all sessions and their tabs.
 */
export async function closeAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map((id) => closeSession(id)));
}

/**
 * List all tabIds for OpenCLI's `tabs(op:list)`.
 */
export function listAllTabs(): Array<{ tabId: string; sessionId: string }> {
  return [...sessions.entries()].map(([sessionId, m]) => ({
    tabId: m.tabId,
    sessionId,
  }));
}

/**
 * Debug/stats accessor — used by translators and by smoke tests.
 */
export function stats(): {
  size: number;
  evictionsLru: number;
  evictionsTtl: number;
  lastEvictionAt: string | null;
  max: number;
  ttlMs: number;
} {
  return {
    size: sessions.size,
    evictionsLru,
    evictionsTtl,
    lastEvictionAt,
    max: MAX_SESSIONS,
    ttlMs: SESSION_TTL_MS,
  };
}

/**
 * Test-only: clear internal state. Not exported in package surface.
 */
export function __resetForTests(): void {
  sessions.clear();
  evictionsLru = 0;
  evictionsTtl = 0;
  lastEvictionAt = null;
}
