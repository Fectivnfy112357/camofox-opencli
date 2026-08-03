import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage for the `cookies` action's host filter.
 *
 * The bug: cookies whose domain carries a leading dot (`.x.com` — the RFC 6265
 * "send to subdomains too" form that Playwright reports verbatim) were dropped
 * when an adapter asked for `https://x.com`, because `"x.com".endsWith(".x.com")`
 * is false. `ct0` is stored exactly that way, so every X/Twitter adapter raised
 * AUTH_REQUIRED against a fully logged-in Camofox profile.
 */

vi.mock('../../src/shim/camofox-client.js', () => ({
  getCookies: vi.fn(),
  evaluate: vi.fn(async () => ({ ok: false })),
  createTab: vi.fn(async () => ({ tabId: 'tab-1', url: 'about:blank' })),
  navigate: vi.fn(async () => ({ ok: true })),
  closeTab: vi.fn(async () => {}),
  listTabs: vi.fn(async () => ({ tabs: [] })),
}));

vi.mock('../../src/shim/session.js', () => ({
  getSession: vi.fn(() => ({ userId: 'fectivnfy', tabId: 'tab-1' })),
  ensureTab: vi.fn(async () => ({ userId: 'fectivnfy', tabId: 'tab-1' })),
  restoreFromLastUrl: vi.fn(),
  navigateSession: vi.fn(),
  listAllTabs: vi.fn(() => []),
}));

import { translateCommand } from '../../src/shim/translator.js';
import * as camofox from '../../src/shim/camofox-client.js';
import * as session from '../../src/shim/session.js';

const mockedGetCookies = camofox.getCookies as unknown as ReturnType<typeof vi.fn>;
const mockedEvaluate = camofox.evaluate as unknown as ReturnType<typeof vi.fn>;
const mockedGetSession = session.getSession as unknown as ReturnType<typeof vi.fn>;

/**
 * Shaped after a real `GET /sessions/fectivnfy/cookies` response: a mix of
 * dotted (domain) and undotted (host-only) cookies across many logged-in sites.
 */
const COOKIE_JAR = [
  // X / Twitter — the adapters read ct0 for the X-Csrf-Token header.
  { name: 'ct0', value: 'csrf-token-value', domain: '.x.com', path: '/' },
  { name: 'auth_token', value: 'auth-value', domain: '.x.com', path: '/', httpOnly: true },
  { name: 'twid', value: 'u%3D2083911662109937664', domain: '.x.com', path: '/' },
  { name: 'lang', value: 'en', domain: 'x.com', path: '/' },

  // Other sites that must keep working.
  { name: 'reddit_session', value: 'r-sess', domain: '.reddit.com', path: '/' },
  { name: 'loid', value: 'r-loid', domain: 'reddit.com', path: '/' },
  { name: 'z_c0', value: 'zhihu-auth', domain: '.zhihu.com', path: '/' },
  { name: 'SESSDATA', value: 'bili-sess', domain: '.bilibili.com', path: '/' },
  { name: 'ttwid', value: 'tt-id', domain: '.tiktok.com', path: '/' },
  { name: 'SID', value: 'google-sid', domain: '.google.com', path: '/' },
  { name: 'web_session', value: 'xhs-sess', domain: '.xiaohongshu.com', path: '/' },

  // Suffix-collision decoys: these must never leak into a different site.
  { name: 'evil', value: 'nope', domain: 'ample.com', path: '/' },
  { name: 'evil2', value: 'nope', domain: '.notx.com', path: '/' },
  { name: 'evil3', value: 'nope', domain: '.myreddit.com', path: '/' },
];

async function getCookiesFor(opts: { url?: string; domain?: string }) {
  const res = await translateCommand({
    id: 'c1',
    action: 'cookies',
    session: 'default',
    ...opts,
  } as never);
  expect(res.ok).toBe(true);
  return res.data as Array<{ name: string; domain: string }>;
}

const names = (cookies: Array<{ name: string }>) => cookies.map((c) => c.name).sort();

beforeEach(() => {
  mockedGetCookies.mockReset();
  mockedGetCookies.mockResolvedValue({ ok: true, cookies: COOKIE_JAR });
  mockedEvaluate.mockReset();
  mockedEvaluate.mockResolvedValue({ ok: false });
  mockedGetSession.mockReset();
  mockedGetSession.mockReturnValue({ userId: 'fectivnfy', tabId: 'tab-1' });
});

describe('cookies filter — the AUTH_REQUIRED regression', () => {
  it('returns dot-prefixed ct0 when querying https://x.com', async () => {
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    const ct0 = cookies.find((c) => c.name === 'ct0');
    expect(ct0).toBeDefined();
    expect(ct0!.domain).toBe('.x.com');
  });

  it('returns every x.com cookie, dotted and host-only alike', async () => {
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    expect(names(cookies)).toEqual(['auth_token', 'ct0', 'lang', 'twid']);
  });

  it('reproduces the exact adapter lookup: page.getCookies({url}) then find ct0', async () => {
    // Mirrors clis/twitter/search.js — the call that used to throw AuthRequiredError.
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    const ct0 = cookies.find((c) => c.name === 'ct0')?.value || null;
    expect(ct0).toBe('csrf-token-value');
  });
});

describe('cookies filter — other sites still work', () => {
  it.each([
    ['https://www.reddit.com', ['loid', 'reddit_session']],
    ['https://reddit.com', ['loid', 'reddit_session']],
    ['https://www.zhihu.com', ['z_c0']],
    ['https://api.bilibili.com', ['SESSDATA']],
    ['https://www.tiktok.com', ['ttwid']],
    ['https://accounts.google.com', ['SID']],
    ['https://www.xiaohongshu.com', ['web_session']],
  ])('%s returns exactly its own cookies', async (url, expected) => {
    expect(names(await getCookiesFor({ url }))).toEqual(expected);
  });

  it('sends dotted cookies to subdomains (the point of the leading dot)', async () => {
    const cookies = await getCookiesFor({ url: 'https://api.x.com' });
    expect(cookies.map((c) => c.name)).toContain('ct0');
  });
});

describe('cookies filter — no cross-domain leakage', () => {
  it('does not hand ample.com cookies to example.com', async () => {
    const cookies = await getCookiesFor({ url: 'https://example.com' });
    expect(names(cookies)).toEqual([]);
  });

  it('does not treat notx.com as a match for x.com', async () => {
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    expect(cookies.map((c) => c.name)).not.toContain('evil2');
  });

  it('does not treat myreddit.com as a match for reddit.com', async () => {
    const cookies = await getCookiesFor({ url: 'https://reddit.com' });
    expect(cookies.map((c) => c.name)).not.toContain('evil3');
  });

  it('never returns another site\'s cookies for x.com', async () => {
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    for (const c of cookies) {
      expect(c.domain.replace(/^\./, '')).toBe('x.com');
    }
  });
});

describe('cookies filter — untouched behaviours', () => {
  it('the cmd.domain branch still matches dotted and exact domains', async () => {
    expect(names(await getCookiesFor({ domain: 'x.com' })))
      .toEqual(['auth_token', 'ct0', 'lang', 'twid']);
  });

  it('returns the whole jar when neither url nor domain is given', async () => {
    const cookies = await getCookiesFor({});
    expect(cookies).toHaveLength(COOKIE_JAR.length);
  });

  it('matches host case-insensitively', async () => {
    const cookies = await getCookiesFor({ url: 'https://X.COM' });
    expect(cookies.map((c) => c.name)).toContain('ct0');
  });

  it('falls back to the full jar on an unparseable url', async () => {
    const cookies = await getCookiesFor({ url: 'not-a-url' });
    expect(cookies).toHaveLength(COOKIE_JAR.length);
  });

  it('returns [] rather than throwing when Camofox has no cookies', async () => {
    mockedGetCookies.mockResolvedValue({ ok: true, cookies: [] });
    expect(await getCookiesFor({ url: 'https://x.com' })).toEqual([]);
  });
});

/**
 * Second regression: cookies live on the Camofox browser *context* (userId),
 * not on a tab, so reading them must not require a navigate to have happened
 * first. `handleCookies` used to `return []` whenever the session map had no
 * entry, which made cold-start adapters that call getCookies() as their very
 * first action (e.g. `zhihu whoami` → verifyZhihuIdentity) report a logged-in
 * profile as anonymous.
 */
describe('cookies without a session (cold start)', () => {
  beforeEach(() => {
    mockedGetSession.mockReturnValue(undefined);
  });

  it('still reaches the Camofox cookie jar when no tab exists', async () => {
    const cookies = await getCookiesFor({ url: 'https://www.zhihu.com' });
    expect(cookies.map((c) => c.name)).toContain('z_c0');
  });

  it('does not return an empty list just because navigate has not run', async () => {
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    expect(cookies.map((c) => c.name)).toContain('ct0');
  });

  it('falls back to CAMOFOX_USER_ID when the session map is empty', async () => {
    const prev = process.env.CAMOFOX_USER_ID;
    process.env.CAMOFOX_USER_ID = 'fectivnfy';
    await getCookiesFor({ url: 'https://x.com' });
    expect(mockedGetCookies).toHaveBeenCalledWith('fectivnfy');
    if (prev === undefined) delete process.env.CAMOFOX_USER_ID;
    else process.env.CAMOFOX_USER_ID = prev;
  });

  it('prefers the session userId when a session does exist', async () => {
    mockedGetSession.mockReturnValue({ userId: 'alice', tabId: 'tab-9' });
    await getCookiesFor({ url: 'https://x.com' });
    expect(mockedGetCookies).toHaveBeenCalledWith('alice');
  });

  it('skips the document.cookie fallback when there is no tab to evaluate in', async () => {
    mockedGetCookies.mockResolvedValue({ ok: true, cookies: [] });
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    expect(cookies).toEqual([]);
    expect(mockedEvaluate).not.toHaveBeenCalled();
  });

  it('still uses the document.cookie fallback when a tab IS available', async () => {
    mockedGetSession.mockReturnValue({ userId: 'fectivnfy', tabId: 'tab-1' });
    mockedGetCookies.mockResolvedValue({ ok: true, cookies: [] });
    mockedEvaluate.mockResolvedValue({
      ok: true,
      result: [{ name: 'visible', value: 'v', domain: 'x.com', path: '/' }],
    });
    const cookies = await getCookiesFor({ url: 'https://x.com' });
    expect(cookies.map((c) => c.name)).toEqual(['visible']);
    expect(mockedEvaluate).toHaveBeenCalled();
  });
});
