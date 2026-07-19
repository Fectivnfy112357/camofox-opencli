/**
 * Camofox REST API client — thin wrapper over fetch().
 */
import type {
  CamofoxTab,
  CamofoxCookie,
  CamofoxEvaluateResult,
  CamofoxScreenshotResult,
  CamofoxSnapshotResult,
} from './types.js';

const CAMOFOX_URL = process.env.CAMOFOX_URL?.replace(/\/$/, '') || 'http://localhost:9377';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_USER_ID = process.env.CAMOFOX_USER_ID || 'fectivnfy';
const CAMOFOX_HEADERS: Record<string, string> = {};
if (process.env.CAMOFOX_API_KEY) {
  CAMOFOX_HEADERS.Authorization = `Bearer ${process.env.CAMOFOX_API_KEY}`;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { timeout?: number },
): Promise<T> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${CAMOFOX_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...CAMOFOX_HEADERS },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok && !data.ok) {
      throw new Error((data.error as string) ?? `Camofox ${res.status}: ${res.statusText}`);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tabs ──────────────────────────────────────────────────────────

export async function createTab(userId: string, sessionKey?: string, url?: string): Promise<CamofoxTab> {
  return api('POST', '/tabs', { userId, sessionKey: sessionKey || userId, ...(url ? { url } : {}) });
}

export async function listTabs(userId: string): Promise<{ tabs: CamofoxTab[] }> {
  return api('GET', `/tabs?userId=${encodeURIComponent(userId)}`);
}

export async function closeTab(tabId: string, userId: string): Promise<void> {
  await api('DELETE', `/tabs/${tabId}`, { userId });
}

// ─── Navigation ────────────────────────────────────────────────────

export async function navigate(tabId: string, url: string, userId?: string): Promise<{ ok: boolean }> {
  return api('POST', `/tabs/${tabId}/navigate`, { userId: userId || DEFAULT_USER_ID, url });
}

// ─── Evaluate (JS execution) ───────────────────────────────────────

export async function evaluate(tabId: string, code: string, userId?: string, timeout?: number): Promise<CamofoxEvaluateResult> {
  return api('POST', `/tabs/${tabId}/evaluate`, { userId: userId || DEFAULT_USER_ID, expression: code, timeout: timeout || 120_000 });
}

// ─── Screenshot ────────────────────────────────────────────────────

export async function screenshot(
  tabId: string,
  options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; userId?: string },
): Promise<CamofoxScreenshotResult> {
  // camofox `GET /tabs/:id/screenshot` returns raw PNG/JPEG bytes
  // (Content-Type: image/png) — NOT a JSON wrapper. The shared `api()`
  // helper does res.json(), which fails on binary with
  // "Unexpected token '', \"PNG\\r\\n...\"". Hit the endpoint directly.
  const params = new URLSearchParams();
  params.set('userId', options?.userId || DEFAULT_USER_ID);
  if (options?.format) params.set('format', options.format);
  if (options?.quality) params.set('quality', String(options.quality));
  if (options?.fullPage) params.set('fullPage', 'true');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/screenshot?${params.toString()}`, {
      method: 'GET',
      headers: CAMOFOX_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Camofox screenshot ${res.status}: ${errBody || res.statusText}`);
    }
    const ab = await res.arrayBuffer();
    const data = Buffer.from(ab).toString('base64');
    return { ok: true, data, format: options?.format ?? 'png' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Snapshot ──────────────────────────────────────────────────────

export async function snapshot(tabId: string, userId?: string): Promise<CamofoxSnapshotResult> {
  return api('GET', `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(userId || DEFAULT_USER_ID)}`);
}

// ─── Interactions ──────────────────────────────────────────────────

export async function clickElement(tabId: string, ref: string, userId?: string): Promise<{ ok: boolean }> {
  return api('POST', `/tabs/${tabId}/click`, { userId: userId || DEFAULT_USER_ID, ref });
}

export async function typeText(tabId: string, ref: string, text: string, userId?: string): Promise<{ ok: boolean }> {
  return api('POST', `/tabs/${tabId}/type`, { userId: userId || DEFAULT_USER_ID, ref, text });
}

export async function pressKey(tabId: string, key: string, userId?: string): Promise<{ ok: boolean }> {
  return api('POST', `/tabs/${tabId}/press`, { userId: userId || DEFAULT_USER_ID, key });
}

export async function scrollPage(tabId: string, direction: 'up' | 'down', userId?: string): Promise<{ ok: boolean }> {
  return api('POST', `/tabs/${tabId}/scroll`, { userId: userId || DEFAULT_USER_ID, direction });
}

export async function goBack(tabId: string, userId?: string): Promise<{ ok: boolean }> {
  return api('POST', `/tabs/${tabId}/back`, { userId: userId || DEFAULT_USER_ID });
}

// ─── Cookies ───────────────────────────────────────────────────────

export async function getCookies(userId: string): Promise<{ ok: boolean; cookies: CamofoxCookie[] }> {
  return api('GET', `/sessions/${userId}/cookies`);
}

export async function setCookies(userId: string, cookies: CamofoxCookie[]): Promise<{ ok: boolean }> {
  return api('POST', `/sessions/${userId}/cookies`, { cookies });
}

// ─── Session ───────────────────────────────────────────────────────

export async function deleteSession(userId: string): Promise<{ ok: boolean }> {
  return api('DELETE', `/sessions/${userId}`);
}

// ─── Health ────────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${CAMOFOX_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}