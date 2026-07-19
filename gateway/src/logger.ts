import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal structured logger for the gateway. Writes newline-delimited JSON
 * to a file (for out-of-container inspection via a mounted volume) AND mirrors
 * a human-readable line to stdout. File logging is best-effort — a write
 * failure never throws into the request path (avoids the "stdout reader thread
 * crash" class of failures seen with supervisord /dev/stdout).
 *
 * Config via env:
 *   GATEWAY_LOG_DIR   — directory for gateway.log (default /var/log/gateway).
 *                       Empty string disables file logging (stdout only).
 *   GATEWAY_LOG_LEVEL — debug|info|warn|error (default info).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let logFile: string | null = null;
let minLevel = ORDER.info;
let fileBroken = false;

export function initLogger(env: NodeJS.ProcessEnv): void {
  const lvl = (env.GATEWAY_LOG_LEVEL?.trim().toLowerCase() as Level) || 'info';
  minLevel = ORDER[lvl] ?? ORDER.info;

  const dirRaw = env.GATEWAY_LOG_DIR?.trim();
  const dir = dirRaw === undefined ? '/var/log/gateway' : dirRaw;
  if (!dir) { logFile = null; return; } // explicitly disabled
  try {
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, 'gateway.log');
  } catch (e) {
    logFile = null;
    fileBroken = true;
    process.stdout.write(`[gateway] log file disabled: ${(e as Error).message}\n`);
  }
}

function write(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < minLevel) return;
  // A monotonic-ish timestamp; Date is fine here (not a workflow sandbox).
  const ts = new Date().toISOString();
  const rec = { ts, level, event, ...fields };
  const line = JSON.stringify(rec);
  // stdout mirror (kept short for supervisord/docker logs)
  process.stdout.write(`[gateway] ${ts} ${level} ${event}${fields ? ' ' + compact(fields) : ''}\n`);
  if (logFile && !fileBroken) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch (e) {
      fileBroken = true;
      process.stdout.write(`[gateway] log file write failed, stdout-only from now: ${(e as Error).message}\n`);
    }
  }
}

function compact(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 120 ? s.slice(0, 120) + '…' : s}`);
  }
  return parts.join(' ');
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
