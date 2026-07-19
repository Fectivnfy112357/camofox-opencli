import { readFileSync } from 'node:fs';

export interface CmdArg {
  name: string;
  type: string;
  required: boolean;
  positional: boolean;
  help?: string;
}

export interface CmdRecord {
  site: string;
  name: string;
  description: string;
  access?: string;
  args: CmdArg[];
}

export class Manifest {
  constructor(private records: CmdRecord[]) {}

  listSites(): string[] {
    return [...new Set(this.records.map((r) => r.site))];
  }

  searchSites(q?: string): { site: string; commands: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      if (q && !r.site.toLowerCase().includes(q.toLowerCase())) continue;
      counts.set(r.site, (counts.get(r.site) ?? 0) + 1);
    }
    return [...counts.entries()].map(([site, commands]) => ({ site, commands }));
  }

  getSiteHelp(site: string): CmdRecord[] {
    return this.records.filter((r) => r.site === site);
  }

  findCommand(site: string, command: string): CmdRecord | undefined {
    return this.records.find((r) => r.site === site && r.name === command);
  }
}

export function loadManifest(path: string): Manifest {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as any[];
  const records: CmdRecord[] = raw.map((r) => ({
    site: String(r.site),
    name: String(r.name),
    description: String(r.description ?? ''),
    access: r.access,
    args: Array.isArray(r.args)
      ? r.args.map((a: any) => ({
          name: String(a.name),
          type: String(a.type ?? 'str'),
          required: Boolean(a.required),
          positional: Boolean(a.positional),
          help: a.help ? String(a.help) : undefined,
        }))
      : [],
  }));
  return new Manifest(records);
}
