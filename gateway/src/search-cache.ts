/**
 * Search-cache — built once at gateway startup from the opencli manifest.
 * Maps each site that has a `search` command to a normalised SearchEntry
 * describing its real positional name(s) and flag spec. The MCP `search`
 * tool uses this so callers can pass { site, query, limit, extras } in
 * one shape regardless of which alias (query / keyword / q / text) the
 * underlying adapter actually expects.
 *
 * Implementation note: a plain Map. No LRU, no TTL — manifest is a static
 * config snapshot. 173 sites ≈ 50KB, never GC'd.
 */
import type { CmdArg, CmdRecord, Manifest } from './manifest.js';

export interface FlagSpec {
  type: 'str' | 'int' | 'bool';
  required: boolean;
}

export interface SearchEntry {
  record: CmdRecord;
  /** Manifest name of the primary required positional (a.k.a. "the query"). */
  firstPositional: string;
  /** Other positionals in declaration order — caller must supply via `extras`. */
  otherPositionals: string[];
  /** Flag-style args (--name value) keyed by their manifest name. */
  flagSpec: Map<string, FlagSpec>;
}

/**
 * Aliases that all map onto the search command's primary positional.
 * Order matters: longer / more specific first, then short forms.
 */
export const QUERY_ALIASES: readonly string[] = ['query', 'keyword', 'q', 'text', 'term'];

const cache = new Map<string, SearchEntry>();
let built = false;

export function build(manifest: Manifest): void {
  if (built) return;
  for (const site of manifest.listSites()) {
    const rec = manifest.findCommand(site, 'search');
    if (!rec || rec.args.length === 0) continue;
    const positionals = rec.args.filter((a) => a.positional);
    const flags = rec.args.filter((a) => !a.positional);
    const [first, ...rest] = positionals;
    if (!first) continue;
    cache.set(site, {
      record: rec,
      firstPositional: first.name,
      otherPositionals: rest.map((a) => a.name),
      flagSpec: new Map(flags.map((a: CmdArg) => [a.name, {
        type: a.type as FlagSpec['type'],
        required: a.required,
      }])),
    });
  }
  built = true;
}

export function get(site: string): SearchEntry | undefined {
  return cache.get(site);
}

export function hasSite(site: string): boolean {
  return cache.has(site);
}

export function size(): number {
  return cache.size;
}

/**
 * Resolve an alias (`query`/`keyword`/`q`/...) against the site's real
 * positional name. Returns either the canonical alias if it matches, or
 * the first Positional's manifest name otherwise. Used by the `search`
 * MCP handler and by the alias shim in buildArgs.
 */
export function resolveQueryAlias(entry: SearchEntry, suppliedKey: string): string | null {
  if (suppliedKey === entry.firstPositional) return entry.firstPositional;
  if ((QUERY_ALIASES as readonly string[]).includes(suppliedKey)) return entry.firstPositional;
  return null;
}

/** For tests / debug inspection. */
export function __resetForTests(): void {
  cache.clear();
  built = false;
}
