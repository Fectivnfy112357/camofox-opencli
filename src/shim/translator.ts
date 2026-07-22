/**
 * Command translator — maps OpenCLI DaemonCommand to Camofox REST API calls.
 */
import type { DaemonCommand, DaemonResult } from './types.js';
import * as camofox from './camofox-client.js';
import * as session from './session.js';

/**
 * Network capture commands — Camofox REST API does not expose raw CDP
 * Network domain, but `opencli browser <cmd>` primitives (open, click,
 * navigate) eagerly call startNetworkCapture to seed initial-request
 * tracking. Returning success + empty data lets the calling CLI flow
 * continue; capture-aware features (opencli browser network) silently
 * get no data, which matches the documented fallback in opencli's
 * page.ts ("returns an empty capture when network-capture-read is
 * unsupported").
 */
async function handleNetworkCaptureStart(cmd: DaemonCommand): Promise<unknown> {
  // Don't require an existing session. opencli's `browser open` flow invokes
  // startNetworkCapture AFTER it has already issued `bind`+`navigate` but
  // some clients also probe it early to gate UI; either way returning success
  // matches the documented opencli fallback ("empty capture when unsupported").
  // Returning success regardless of session map state avoids spurious
  // "No active session — navigate first" errors during bind+open sequences.
  return { ok: true, supported: false };
}

async function handleNetworkCaptureRead(cmd: DaemonCommand): Promise<unknown> {
  return []; // empty capture — matches opencli fallback semantics
}

/**
 * Commands Camofox genuinely cannot support (CDP-specific / Firefox-
 * impossible). Returning error here triggers the opencli fallback path
 * (memoised "unsupported" in page.ts) so retries become no-ops.
 */
const UNSUPPORTED = new Set([
  'set-file-input',
  'wait-download',
  'cdp',
  'frames',
]);

/**
 * Main dispatch: translate a DaemonCommand and return a DaemonResult.
 */
export async function translateCommand(
  cmd: DaemonCommand,
): Promise<DaemonResult> {
  const { id, action } = cmd;

  if (UNSUPPORTED.has(action)) {
    return {
      id,
      ok: false,
      errorCode: 'unsupported_backend',
      error: `Action '${action}' is not supported by Camofox Shim`,
    };
  }

  try {
    const data = await dispatch(cmd);
    return { id, ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Self-healing: external events (manual VNC login that opens a fresh
    // tab, Camofox IDLE_TIMEOUT eviction) can silently drop the tab our
    // session Map is pointing at. Detect that specific failure shape and
    // retry once after rebuilding the session from its lastUrl.
    if (
      cmd.session &&
      /tab not found|target id .*not found|page not found/i.test(message) &&
      !cmd.retriedAfterSessionRestore
    ) {
      try {
        await session.restoreFromLastUrl(cmd.session);
        const retry: DaemonCommand = { ...cmd, retriedAfterSessionRestore: true };
        const data = await dispatch(retry);
        return { id, ok: true, data };
      } catch (retryErr) {
        const m2 = retryErr instanceof Error ? retryErr.message : String(retryErr);
        return { id, ok: false, error: `self-heal retry failed: ${m2}` };
      }
    }
    return { id, ok: false, error: message };
  }
}

async function dispatch(cmd: DaemonCommand): Promise<unknown> {
  switch (cmd.action) {
    case 'navigate':
      return handleNavigate(cmd);
    case 'exec':
      return handleExec(cmd);
    case 'screenshot':
      return handleScreenshot(cmd);
    case 'cookies':
      return handleCookies(cmd);
    case 'tabs':
      return handleTabs(cmd);
    case 'close-window':
      return handleCloseWindow(cmd);
    case 'insert-text':
      return handleInsertText(cmd);
    case 'bind':
      return handleBind(cmd);
    case 'lease-release':
      return { ok: true }; // no-op — shim has no lease to release
    case 'network-capture-start':
      return handleNetworkCaptureStart(cmd);
    case 'network-capture-read':
      return handleNetworkCaptureRead(cmd);
    default:
      throw new Error(`Unknown action: ${cmd.action}`);
  }
}

// ─── Navigate ──────────────────────────────────────────────────────

async function handleNavigate(cmd: DaemonCommand): Promise<unknown> {
  const url = cmd.url;
  if (!url) throw new Error('navigate requires a url');
  const m = await session.ensureTab(cmd.session || 'default', cmd.contextId);
  await session.navigateSession(m, url);
  return { page: m.tabId };
}

// ─── Exec (JS evaluation) ──────────────────────────────────────────

async function handleExec(cmd: DaemonCommand): Promise<unknown> {
  const code = cmd.code;
  if (!code) throw new Error('exec requires code');
  const m = session.getSession(cmd.session || 'default');
  if (!m) throw new Error('No active session — navigate first');
  const result = await camofox.evaluate(m.tabId, code);
  if (!result.ok) throw new Error(result.error ?? 'evaluate failed');
  return result.result;
}

// ─── Screenshot ────────────────────────────────────────────────────

async function handleScreenshot(cmd: DaemonCommand): Promise<unknown> {
  const m = session.getSession(cmd.session || 'default');
  if (!m) throw new Error('No active session — navigate first');
  const result = await camofox.screenshot(m.tabId, {
    format: cmd.format,
    quality: cmd.quality,
    fullPage: cmd.fullPage,
  });
  if (!result.ok) throw new Error('screenshot failed');
  return result.data; // base64 string
}

// ─── Cookies ───────────────────────────────────────────────────────

async function handleCookies(cmd: DaemonCommand): Promise<unknown> {
  const m = session.getSession(cmd.session || 'default');
  if (!m) return [];

  // Try the Camofox GET cookies endpoint first (handles HttpOnly via Playwright context).
  // Fall back to document.cookie if the endpoint is unavailable.
  let cookies: Array<{ name: string; value: string; domain: string; path?: string; httpOnly?: boolean }> = [];
  try {
    const result = await camofox.getCookies(m.userId);
    if (result.ok && Array.isArray(result.cookies)) {
      cookies = result.cookies;
    }
  } catch {
    // Fall through to document.cookie path
  }

  if (cookies.length === 0) {
    // Fallback: read document.cookie via evaluate. Does NOT include HttpOnly.
    try {
      const js = `document.cookie.split('; ').filter(Boolean).map(c => {
        const [name, ...rest] = c.split('=');
        return { name, value: rest.join('='), domain: location.hostname, path: '/' };
      })`;
      const evResult = await camofox.evaluate(m.tabId, js);
      if (evResult.ok && Array.isArray(evResult.result)) {
        cookies = evResult.result as typeof cookies;
      }
    } catch {
      // No tab yet — return empty
    }
  }

  // Filter by domain/url if specified
  if (cmd.domain) {
    cookies = cookies.filter(
      (c) => c.domain === cmd.domain || c.domain.endsWith('.' + cmd.domain),
    );
  }
  if (cmd.url) {
    try {
      const host = new URL(cmd.url).hostname;
      cookies = cookies.filter(
        (c) => c.domain === host || host.endsWith(c.domain),
      );
    } catch {
      // ignore invalid URL, return all
    }
  }
  return cookies;
}

// ─── Tabs ──────────────────────────────────────────────────────────

async function handleTabs(cmd: DaemonCommand): Promise<unknown> {
  const m = session.getSession(cmd.session || 'default');
  const userId = m?.userId || process.env.CAMOFOX_USER_ID || 'default';

  switch (cmd.op) {
    case 'list': {
      const result = await camofox.listTabs(userId);
      return result.tabs.map((t: { tabId: string }) => ({
        page: t.tabId,
        tabId: t.tabId,
      }));
    }
    case 'new': {
      const sessionKey = cmd.session || 'default';
      const tab = await camofox.createTab(userId, sessionKey, cmd.url);
      return { page: tab.tabId };
    }
    case 'close': {
      const tabId = cmd.page || m?.tabId;
      if (tabId) await camofox.closeTab(tabId, userId);
      return { closed: tabId };
    }
    case 'select': {
      return { page: cmd.page || m?.tabId };
    }
    default:
      throw new Error(`Unknown tabs op: ${cmd.op}`);
  }
}

// ─── Close window ──────────────────────────────────────────────────

async function handleCloseWindow(cmd: DaemonCommand): Promise<unknown> {
  const m = session.getSession(cmd.session || 'default');
  if (m) {
    await session.closeSession(cmd.session || 'default');
  }
  return { ok: true };
}

// ─── Insert text ───────────────────────────────────────────────────

async function handleInsertText(cmd: DaemonCommand): Promise<unknown> {
  const text = cmd.text;
  if (!text) throw new Error('insert-text requires text');
  const m = session.getSession(cmd.session || 'default');
  if (!m) throw new Error('No active session');
  // Use evaluate to insert text into the focused element
  const escaped = JSON.stringify(text);
  const code = `(function(){
    const el = document.activeElement;
    if (!el) throw new Error('No focused element');
    const v = ${escaped};
    if (el.isContentEditable) {
      el.textContent += v;
    } else {
      const start = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, start) + v + el.value.slice(el.selectionEnd ?? start);
      el.selectionStart = el.selectionEnd = start + v.length;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { inserted: true };
  })()`;
  await camofox.evaluate(m.tabId, code);
  return { inserted: true };
}

// ─── Bind ──────────────────────────────────────────────────────────

async function handleBind(_cmd: DaemonCommand): Promise<unknown> {
  // bind is a no-op in shim — session mapping is managed internally
  return { ok: true };
}