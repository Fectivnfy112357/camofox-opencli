/**
 * Camofox Shim v2 — WebSocket client connecting to the OpenCLI daemon.
 *
 * Does NOT listen on any port — connects to the daemon's /ext WebSocket
 * as a fake Chrome Extension. The daemon owns port 19825.
 *
 * Flow:
 *   CLI → HTTP POST /command → daemon(:19825) → WS → Shim → Camofox REST(:9377)
 */
import { WebSocket } from 'ws';
import type { DaemonCommand, DaemonResult } from './types.js';
import * as camofox from './camofox-client.js';
import { translateCommand } from './translator.js';

const DAEMON_WS = process.env.OPENCLI_DAEMON_WS || 'ws://127.0.0.1:19825/ext';
const RECONNECT_DELAY = 3000;
const PING_INTERVAL = 15_000;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let cmdCount = 0;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log(`[shim] Connecting to daemon at ${DAEMON_WS}`);
  ws = new WebSocket(DAEMON_WS);

  ws.on('open', () => {
    console.log('[shim] Connected — registering as fake extension');
    ws!.send(JSON.stringify({
      type: 'hello',
      version: 'shim-1.0.0',
      contextId: 'default',
      compatRange: '>=1.0.0',
    }));
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL);
  });

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping' || msg.type === 'log') return;
      if (msg.id && msg.action) {
        cmdCount++;
        const cmd = msg as DaemonCommand;
        console.log(`[shim] #${cmdCount} ${cmd.action}`);
        const result: DaemonResult = await translateCommand(cmd);
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
      }
    } catch (err) {
      console.error('[shim] Error:', err);
    }
  });

  ws.on('close', (code) => {
    console.log(`[shim] Disconnected (${code}), reconnecting...`);
    cleanup();
    setTimeout(connect, RECONNECT_DELAY);
  });

  ws.on('error', (err) => {
    console.error('[shim] WS error:', err.message);
  });
}

function cleanup() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

console.log('[shim] Camofox Shim v2 (WebSocket client mode)');
camofox.healthCheck().then((ok) => {
  console.log(ok ? '[shim] Camofox: OK' : '[shim] Camofox: FAILED');
  connect();
});

process.on('SIGTERM', () => { cleanup(); ws?.close(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); ws?.close(); process.exit(0); });