// @wc-ignore-file
import type { ConnectionReference, HostProxy } from './store.js';

export const PLATFORM = 'clockify';

/**
 * How the app reaches Clockify through the integration proxy. The sync loop
 * only ever sees this interface, so it cannot hold, rotate or persist a
 * credential; whoever implements it owns authority.
 *
 * The one implementation is the host relay (`relayTransport`): the parent
 * page performs the call with the connection it holds and returns only
 * `{ status, headers, body }`. A signed capability (#40) would be a second
 * implementation; it is not built.
 */
export interface ProxyTransport {
  request(
    path: string,
    query?: Record<string, string>,
  ): Promise<{
    status: number;
    body: unknown;
    /** Lower-cased; the relay passes `retry-after` among a few others. */
    headers?: Record<string, string>;
  }>;
}

export class ProxyError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
    /** The `retry-after` header, as relayed (seconds or an HTTP date). */
    readonly retryAfter?: string,
  ) {
    const detail =
      body && typeof body === 'object' && 'message' in body
        ? `: ${String((body as { message: unknown }).message)}`
        : '';
    super(`Clockify request ${path} failed with ${status}${detail}`);
    this.name = 'ProxyError';
  }
}

export async function requestJson<T>(
  transport: ProxyTransport,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const { status, body, headers } = await transport.request(path, query);
  if (status < 200 || status >= 300)
    throw new ProxyError(path, status, body, headers?.['retry-after']);

  return body as T;
}

/**
 * The host-relayed transport for one connection. There is intentionally no
 * frame-side fallback that takes a rotating code: the frame is null-origin,
 * has no storage, and a resource must not carry a credential (#21).
 */
export function relayTransport(
  proxy: HostProxy,
  connection: ConnectionReference,
): ProxyTransport {
  return {
    request: (path, query) =>
      proxy.request({
        platform: connection.platform,
        connectionId: connection.connectionId,
        path,
        method: 'GET',
        ...(query ? { query } : {}),
      }),
  };
}
