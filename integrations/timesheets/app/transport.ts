// @wc-ignore-file
import type { ConnectionReference } from './config.js';
import type { PluginStore } from './store.js';

/**
 * How the app reaches Clockify through the integration proxy. The sync loop
 * only ever sees this interface, so it cannot hold, rotate or persist a
 * credential; whoever implements it owns authority.
 *
 * Two implementations are anticipated, neither available yet:
 * - host relay: the parent page performs the call with its own
 *   BrowserIntegrations (rotating code in the parent's localStorage) and
 *   returns only `{ status, body }` — `hostTransport()` below, pending the op
 *   in atomic-server#1624;
 * - signed capability (#40): the parent mints a short-lived capability as the
 *   app agent and a frame-side implementation sends
 *   `Authorization: Capability <token>` itself. Not built: #40 is unaccepted.
 */
export interface ProxyTransport {
  request(
    path: string,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
}

export class ProxyError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
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
  const { status, body } = await transport.request(path, query);
  if (status < 200 || status >= 300) throw new ProxyError(path, status, body);

  return body as T;
}

/**
 * The host-relayed transport, or `undefined` when this host cannot reach
 * the proxy on the app's behalf. There is intentionally no frame-side
 * fallback that takes a rotating code: the frame is null-origin, has no
 * storage, and a resource must not carry a credential (#21).
 */
export function hostTransport(
  store: PluginStore,
  reference: ConnectionReference,
): ProxyTransport | undefined {
  const proxy = store.proxy;
  if (!proxy || typeof proxy.request !== 'function') return undefined;

  return {
    request: (path, query) =>
      proxy.request({
        platform: reference.platform,
        connectionId: reference.connectionId,
        path,
        ...(query ? { query } : {}),
      }),
  };
}
