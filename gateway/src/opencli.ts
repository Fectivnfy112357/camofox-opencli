import { spawn } from 'node:child_process';
import type { CmdRecord } from './manifest.js';

export interface RunResult {
  ok: boolean;
  data?: unknown;
  stderr?: string;
}

export function buildArgs(record: CmdRecord, args: Record<string, unknown>): string[] {
  const positionals = record.args.filter((a) => a.positional);
  const flags = record.args.filter((a) => !a.positional);
  const out: string[] = [];

  // Alias tolerance: callers may pass an alias for the first positional
  // (e.g. bilibili uses 'query', but some clients send 'keyword'). Resolve
  // once and remap before iterating positional specs so the existing
  // required-check machinery stays intact.
  const resolvedArgs = resolveFirstPositionalAlias(record, positionals, args);
  const source = resolvedArgs ?? args;

  for (const a of positionals) {
    if (source[a.name] === undefined || source[a.name] === null) {
      if (a.required) throw new Error(`missing required arg: ${a.name}`);
      continue;
    }
    out.push(String(source[a.name]));
  }
  for (const a of flags) {
    const v = source[a.name];
    if (v === undefined || v === null) {
      if (a.required) throw new Error(`missing required arg: ${a.name}`);
      continue;
    }
    if (a.type === 'boolean') {
      if (v === true) out.push(`--${a.name}`);
    } else {
      out.push(`--${a.name}`, String(v));
    }
  }
  out.push('--format', 'json');
  return out;
}

/** Well-known aliases for the primary search/query positional. */
const QUERY_ALIASES = ['query', 'keyword', 'q', 'text', 'term'] as const;

/**
 * If the caller's args object uses a known alias for the first positional,
 * return a shallow copy with that value copied under the canonical name.
 * Otherwise return null — callers fall back to the raw args.
 */
function resolveFirstPositionalAlias(
  record: CmdRecord,
  positionals: { name: string }[],
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const first = positionals[0];
  if (!first) return null;
  if (args[first.name] !== undefined) return null; // already canonical
  const alias = QUERY_ALIASES.find((k) => args[k] !== undefined && args[k] !== null);
  if (!alias) return null;
  // Only alias when the supplied value type matches (primitive). Objects with
  // rich schema (e.g. {0:'a',1:'b'} MCP record quirks) are NOT aliased — we
  // want buildArgs to fall through to its existing positional loop and
  // detect the missing required arg so the error message remains accurate.
  const v = args[alias];
  if (v !== null && typeof v === 'object') return null;
  return { ...args, [first.name]: v };
}

/**
 * Sites that are not adapter commands and thus absent from the manifest:
 * `browser` primitives and top-level `doctor`. These bypass manifest
 * validation and use raw passthrough arg building.
 */
export const PASSTHROUGH_SITES = new Set(['browser', 'doctor']);

/**
 * Build CLI args for passthrough (non-manifest) commands. Returns positionals
 * (from `args._`, with `args.session` promoted to the first slot when present)
 * and flags (from every other key) separately so callers can splice a
 * subcommand between them — the opencli CLI accepts
 *   opencli browser <session> <subcommand> <rest-positionals> --flags
 * but `args._` may contain BOTH the session and the subcommand's own positionals.
 *
 * `args.session` (string) is promoted to the FIRST positional — mirroring the
 * `opencli browser <session> <command>...` CLI shape. Flags are `--key value`
 * (boolean true → bare `--key`, false/null omitted).
 */
export interface RawArgs {
  positionals: string[];
  flags: string[];
  hasSession: boolean;
}
export function buildRawArgs(args: Record<string, unknown>): RawArgs {
  const positionals: string[] = [];
  const flags: string[] = [];
  const hasSession = typeof args.session === 'string' && !!args.session;
  if (hasSession) positionals.push(args.session as string);
  if (Array.isArray(args._)) for (const p of args._) positionals.push(String(p));
  for (const [k, v] of Object.entries(args)) {
    if (k === '_' || k === 'session' || v === undefined || v === null) continue;
    if (v === true) flags.push(`--${k}`);
    else if (v === false) continue;
    else flags.push(`--${k}`, String(v));
  }
  return { positionals, flags, hasSession };
}

/**
 * OpenCLI adapters emit a YAML-flavoured envelope to stdout (not JSON):
 *   ok: false
 *   error:
 *     code: AUTH_REQUIRED
 *     message: "..."
 *     help: "..."
 *   exitCode: 77
 * Two-space indent only. Only `code`/`message`/`help` strings under
 * `error:` are recognised, but the parser is lenient — unknown keys
 * are preserved.
 */
function parseLooseEnvelope(s: string): Record<string, unknown> | null {
  if (!s || !s.trim().startsWith('ok:')) return null;
  const lines = s.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let nested: Record<string, unknown> | null = null;
  let nestedKey = '';
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^( *)/)?.[1].length ?? 0;
    const m = raw.slice(indent).match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    const val = valRaw.replace(/^['"]|['"]$/g, '');
    if (indent === 0) {
      nested = null;
      // A bare `key:` at top level (empty value) is a nested-object marker:
      // the next indented lines fill it.
      if (val === '') {
        nested = {};
        nestedKey = key;
        out[key] = nested;
      } else {
        out[key] = coerceScalar(val);
      }
    } else if (indent >= 2 && nested && nestedKey) {
      (nested as Record<string, unknown>)[key] = val === '' ? null : coerceScalar(val);
    } else if (indent === 2 && val === '') {
      nested = {};
      nestedKey = key;
      out[key] = nested;
    }
  }
  return Object.keys(out).length ? out : null;
}

function coerceScalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

// ─── Screenshot detection ───────────────────────────────────────────────────

/**
 * opencli's `browser screenshot` (no path) writes the raw base64 string to
 * stdout instead of wrapping it in JSON — breaking `--format json`. Detect
 * that shape (ASCII base64 with PNG/JPEG magic, no whitespace, no leading `{`/`[`)
 * and wrap it as `{ data, mimeType }` so MCP clients receive a structured
 * payload they can save or re-render.
 */
const SCREENSHOT_B64_RE = /^(?:iVBORw0KGgo|\/9j\/)[A-Za-z0-9+/=]+$/;
function maybeExtractScreenshot(stdout: string): RunResult | null {
  const t = stdout.trim();
  if (!t || t.length < 80) return null;
  if (t.startsWith('{') || t.startsWith('[')) return null;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(t)) return null;
  const m = t.match(SCREENSHOT_B64_RE);
  if (!m) return null;
  const mimeType = t.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg';
  // Strip accidental newline padding that cli.ts console.log adds.
  const data = t.replace(/\s+/g, '');
  return { ok: true, data: { data, mimeType, format: mimeType === 'image/png' ? 'png' : 'jpeg' } };
}

export function parseResult(code: number, stdout: string, stderr: string): RunResult {
  // 0. Raw base64 PNG/JPEG on stdout (opencli browser screenshot writes the
  //    raw base64 string instead of wrapping it in JSON; capture it before
  //    JSON.parse poisons itself).
  const shot = maybeExtractScreenshot(stdout);
  if (shot) return shot;

  // 1. Strict JSON on stdout (preferred for happy-path data).
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j === 'object') return { ok: true, data: j };
  } catch { /* fall through */ }

  // 2. Loose envelope (YAML-style `ok: false / error: / exitCode:`) on
  //    either stream — covers the case where the adapter exits 0 but
  //    signals failure via the envelope's `ok` flag.
  const env = parseLooseEnvelope(stdout) ?? parseLooseEnvelope(stderr);
  if (env) {
    const isOk = env.ok === true || env.ok === 'true';
    return { ok: isOk, data: env, stderr };
  }

  // 3. Strict JSON on stderr (some adapters emit JSON envelope only on stderr).
  if (stderr.trim()) {
    try {
      const j = JSON.parse(stderr);
      if (j && typeof j === 'object') return { ok: false, data: j, stderr };
    } catch { /* fall through */ }
  }

  // 4. Plain text error on non-zero exit (no envelope detected). Try to
  //    rescue AUTH_REQUIRED-shaped errors from the text so callers
  //    (gateway /run, mcp tools) can still surface VNC login links when
  //    the adapter's stdout/stderr is otherwise unparseable — e.g. when
  //    [UNDICI-EHPA] Warning prefixes the envelope.
  if (code !== 0 || /code:\s*AUTH_REQUIRED\b/.test(stderr + '\n' + stdout)) {
    const rescued = rescueEnvelope(stderr + '\n' + stdout);
    if (rescued) return { ok: false, data: rescued, stderr };
    return { ok: false, stderr: stderr || `exit ${code}` };
  }

  // 5. Truly unparseable stdout on zero exit.
  return { ok: false, stderr: `non-JSON stdout: ${stdout.slice(0, 300)}` };
}

/**
 * Last-resort envelope recovery. Handles streams where the opencli YAML
 * envelope is preceded by extraneous stderr (most commonly the
 * `[UNDICI-EHPA] EnvHttpProxyAgent is experimental` warning that Node
 * v22+ writes before every proxied request). The envelope parser
 * refuses to look at the stream because the leading text breaks the
 * `startsWith('ok:')` guard, so callers used to see a generic
 * `code: 'opencli_error'` with the raw stream embedded in `message`.
 *
 * Pulls out the three fields we route on — `code`, `message`, `help` —
 * even when they're surrounded by other output. Returns null if the
 * stream doesn't look like an opencli envelope at all.
 */
function rescueEnvelope(blob: string): Record<string, unknown> | null {
  const code = blob.match(/\bcode:\s*([A-Z_][A-Z0-9_]*)\b/);
  if (!code) return null;
  // Only treat well-known opencli error codes as worth rescuing.
  const known = new Set([
    'AUTH_REQUIRED', 'ARGUMENT', 'COMMAND_EXEC', 'NOT_FOUND',
    'NO_SEARCH_COMMAND', 'UNKNOWN',
  ]);
  if (!known.has(code[1])) return null;
  const message =
    blob.match(/^[ \t]*message:\s*(.*?)(?=^[ \t]*[a-z_][\w-]*:\s*|\Z)/ms)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') ?? '';
  const help =
    blob.match(/^[ \t]*help:\s*(.*?)(?=^[ \t]*[a-z_][\w-]*:\s*|\Z)/ms)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') ?? '';
  return {
    error: { code: code[1], message, help },
    exitCode: 77, // matched AUTH_REQUIRED's canonical exit code as a hint
  };
}

export function runOpencli(
  bin: string,
  site: string,
  command: string,
  argv: string[],
  opts?: { passthrough?: boolean },
): Promise<RunResult> {
  // For manifest sites, command-line shape is `opencli <site> <command> [args...]`.
  // For passthrough sites (browser, doctor), the `<site>` is the opencli parent
  // command and `<command>` is already embedded in argv (typically as the token
  // immediately following the session positional, e.g. argv=[session, subcmd, ...]).
  // Splicing `command` twice would produce `browser open work open https://x.com`.
  const parts = opts?.passthrough
    ? [site, ...argv]
    : [site, command, ...argv];
  // Drop empty parts so we never spawn `opencli browser ""`.
  const filtered = parts.filter((p) => p !== '' && p != null);
  return new Promise((resolve) => {
    const child = spawn(bin, filtered, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ ok: false, stderr: e.message }));
    child.on('close', (code) => resolve(parseResult(code ?? 1, stdout, stderr)));
  });
}
