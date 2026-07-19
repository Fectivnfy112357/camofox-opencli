import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadManifest } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '__fixtures__', 'manifest.sample.json');

describe('Manifest', () => {
  const m = loadManifest(fixture);

  it('lists unique sites', () => {
    expect(m.listSites().sort()).toEqual(['bilibili', 'hackernews']);
  });

  it('searchSites without q returns all with command counts', () => {
    const all = m.searchSites();
    expect(all.find((s) => s.site === 'bilibili')?.commands).toBe(2);
    expect(all.length).toBe(2);
  });

  it('searchSites with q filters by substring', () => {
    expect(m.searchSites('bili').map((s) => s.site)).toEqual(['bilibili']);
  });

  it('getSiteHelp returns commands for a site', () => {
    const help = m.getSiteHelp('bilibili');
    expect(help.map((c) => c.name).sort()).toEqual(['comment', 'search']);
  });

  it('findCommand returns matching record with normalized args', () => {
    const c = m.findCommand('bilibili', 'search');
    expect(c?.args[0]).toMatchObject({ name: 'keyword', positional: true, required: true });
    expect(c?.args[1]).toMatchObject({ name: 'limit', positional: false, required: false });
  });

  it('findCommand returns undefined for unknown', () => {
    expect(m.findCommand('bilibili', 'nope')).toBeUndefined();
  });
});
