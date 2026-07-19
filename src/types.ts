// ─── OpenCLI → Daemon command types ────────────────────────────────

export type DaemonAction =
  | 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot'
  | 'close-window' | 'set-file-input' | 'insert-text' | 'bind'
  | 'network-capture-start' | 'network-capture-read' | 'wait-download'
  | 'cdp' | 'frames' | 'lease-release';

export interface DaemonCommand {
  id: string;
  action: DaemonAction;
  page?: string;
  code?: string;
  session?: string;
  surface?: 'browser' | 'adapter';
  siteSession?: 'ephemeral' | 'persistent';
  url?: string;
  op?: string;
  index?: number;
  domain?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  width?: number;
  height?: number;
  files?: string[];
  selector?: string;
  text?: string;
  pattern?: string;
  timeoutMs?: number;
  cdpMethod?: string;
  cdpParams?: Record<string, unknown>;
  frameIndex?: number;
  contextId?: string;
  preferredContextId?: string;
  timeout?: number;
  deadlineAt?: number;
  runId?: string;
  command?: string;
  access?: 'read' | 'write';
  /** Internal flag — set when a command is being retried after the shim
   *  detected the underlying tab was lost and rebuilt the session from its
   *  recorded lastUrl. Prevents infinite retry loops on persistent failure. */
  retriedAfterSessionRestore?: boolean;
}

export interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
  page?: string;
}

// ─── Camofox REST API types ────────────────────────────────────────

export interface CamofoxTab {
  tabId: string;
  userId: string;
  url?: string;
  title?: string;
}

export interface CamofoxCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface CamofoxEvaluateResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CamofoxScreenshotResult {
  ok: boolean;
  data?: string; // base64
  format?: string;
}

export interface CamofoxSnapshotResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
}

// ─── Shim internal state ───────────────────────────────────────────

export interface SessionMapping {
  userId: string;
  tabId: string;
  lastUrl?: string;
  /** Epoch ms — used for LRU eviction and TTL reaping. */
  lastUsedAt?: number;
}

export interface PendingEntry {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── WebSocket protocol ────────────────────────────────────────────

export interface WsHello {
  type: 'hello';
  version: string;
  contextId: string;
  compatRange?: string;
}

export interface WsLog {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  msg: string;
  ts?: number;
}

export type WsMessage = WsHello | WsLog | { type: 'ping' };