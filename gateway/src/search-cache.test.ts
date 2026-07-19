import { describe, it, expect, beforeEach } from 'vitest';
import * as searchCache from './search-cache.js';
import { type Manifest, type CmdRecord } from './manifest.js';
import { buildArgs } from './opencli.js';

function makeRecord(args: CmdArg[]): CmdRecord {
  return { site: 'test', name: 'search', description: '', args };
}
type CmdArg = { name: string; type: string; required: boolean; positional: boolean; help?: string };

function makeManifest(records: CmdRecord[]): Manifest {
  const sites = [...new Set(records.map((r) => r.site))];
  return {
    listSites: () => sites,
    searchSites: (q?: string) => sites
      .filter((s) => !q || s.includes(q))
      .map((site) => ({ site, commands: records.filter((r) => r.site === site).length })),
    getSiteHelp: (site: string) => records.filter((r) => r.site === site),
    findCommand: (site: string, command: string) =>
      records.find((r) => r.site === site && r.name === command),
  } as unknown as Manifest;
}

beforeEach(() => {
  searchCache.__resetForTests();
});

describe('search-cache.build', () => {
  it('skips sites without a `search` command', () => {
    const m = makeManifest([{ site: 'twitter', name: 'trending', description: '', args: [] }]);
    searchCache.build(m);
    expect(searchCache.hasSite('twitter')).toBe(false);
  });

  it('captures firstPositional + otherPositionals + flagSpec from a real manifest row', () => {
    const rec = makeRecord([
      { name: 'query', type: 'str', required: true, positional: true },
      { name: 'sort', type: 'str', required: false, positional: false },
      { name: 'limit', type: 'int', required: false, positional: false },
    ]);
    const m = makeManifest([rec]);
    searchCache.build(m);
    const entry = searchCache.get('test');
    expect(entry?.firstPositional).toBe('query');
    expect(entry?.otherPositionals).toEqual([]);
    expect(Array.from(entry!.flagSpec.keys()).sort()).toEqual(['limit', 'sort']);
    expect(entry!.flagSpec.get('limit')).toEqual({ type: 'int', required: false });
  });

  it('captures multiple positionals in declaration order', () => {
    const rec = makeRecord([
      { name: 'keyword', type: 'str', required: true, positional: true }, // not 'query'
      { name: 'type', type: 'str', required: false, positional: true },
      { name: 'limit', type: 'int', required: false, positional: false },
    ]);
    const m = makeManifest([rec]);
    searchCache.build(m);
    const entry = searchCache.get('test')!;
    expect(entry.firstPositional).toBe('keyword');
    expect(entry.otherPositionals).toEqual(['type']);
  });

  it('idempotent: second build() does not double-write', () => {
    const rec = makeRecord([
      { name: 'query', type: 'str', required: true, positional: true },
    ]);
    searchCache.build(makeManifest([rec]));
    searchCache.build(makeManifest([rec]));
    expect(searchCache.size()).toBe(1);
  });
});

describe('search-cache.resolveQueryAlias', () => {
  const rec = makeRecord([
    { name: 'query', type: 'str', required: true, positional: true },
  ]);
  it('returns the canonical name when the supplied key matches', () => {
    searchCache.build(makeManifest([rec]));
    const e = searchCache.get('test')!;
    expect(searchCache.resolveQueryAlias(e, 'query')).toBe('query');
  });
  it('returns firstPositional for any known alias', () => {
    searchCache.build(makeManifest([rec]));
    const e = searchCache.get('test')!;
    for (const k of ['keyword', 'q', 'text', 'term']) {
      expect(searchCache.resolveQueryAlias(e, k)).toBe('query');
    }
  });
  it('returns null for unrelated keys', () => {
    searchCache.build(makeManifest([rec]));
    const e = searchCache.get('test')!;
    expect(searchCache.resolveQueryAlias(e, 'foo')).toBeNull();
  });
});

describe('buildArgs alias tolerance', () => {
  const bilibili = makeRecord([
    { name: 'query', type: 'str', required: true, positional: true },
    { name: 'limit', type: 'int', required: false, positional: false },
  ]);
  it('queries the canonical positional name directly', () => {
    expect(buildArgs(bilibili, { query: 'x' })).toEqual(['x', '--format', 'json']);
  });
  it('accepts `keyword` alias for a `query` positional', () => {
    expect(buildArgs(bilibili, { keyword: 'x' })).toEqual(['x', '--format', 'json']);
  });
  it('accepts `q` / `text` / `term` aliases', () => {
    for (const k of ['q', 'text', 'term']) {
      expect(buildArgs(bilibili, { [k]: 'x' })).toEqual(['x', '--format', 'json']);
    }
  });
  it('forwards non-positional extras untouched', () => {
    expect(buildArgs(bilibili, { keyword: 'x', limit: 10 }))
      .toEqual(['x', '--limit', '10', '--format', 'json']);
  });
  it('does not alias object values (MCP record quirks like {0:"a"})', () => {
    // Test using an alias key supplied with an object value. The alias logic
    // must skip objects (they're not real query strings), so buildArgs sees
    // no value for the canonical positional and throws "missing required arg".
    expect(() => buildArgs(bilibili, { keyword: { 0: 'a' } }))
      .toThrow(/missing required arg: query/);
  });
  it('treats a canonical-name object value as "value, not array"', () => {
    // If the client supplies the canonical name with an object value, we
    // still stringify — that's the documented behaviour and shouldn't throw.
    // The stringified shape is the caller's problem.
    const r = buildArgs(bilibili, { query: { 0: 'a' } });
    expect(r[0]).toBe('[object Object]');
  });
  it('preserves required error when nothing supplied', () => {
    expect(() => buildArgs(bilibili, {}))
      .toThrow(/missing required arg: query/);
  });
});
