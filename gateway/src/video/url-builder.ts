import type { IncomingMessage } from 'node:http';

function first(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(',')[0].trim() || undefined;
}

export function buildAbsoluteUrl(
  req: IncomingMessage,
  pathOnHost: string,
): string | null {
  const headers = req.headers;
  const host = first(headers['x-forwarded-host'] as string | undefined) ?? first(headers.host as string | undefined);
  if (!host) return null;
  const proto = first(headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const port = first(headers['x-forwarded-port'] as string | undefined);
  const hasPort = host.includes(':');
  const hostPart = port && !hasPort ? `${host}:${port}` : host;
  const normalizedPath = pathOnHost.startsWith('/') ? pathOnHost : `/${pathOnHost}`;
  return `${proto}://${hostPart}${normalizedPath}`;
}