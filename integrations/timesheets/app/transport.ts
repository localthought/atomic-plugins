// @wc-ignore-file
import type { ConnectionReference, HostProxy } from './store.js';

export const PLATFORM = 'clockify';

/**
 * How the app reaches Clockify through the integration proxy. The sync loop
 * only ever sees this interface, so it cannot hold, rotate or persist a
 * credential; whoever implements it owns authority.
 *
 * The one implementation is `relayTransport`, over the host's
 * `store.proxy.request`: since ontola/atomic-plugins#54 phase 2 the host's
 * frame client calls the proxy itself, with a capability the page signed and
 * a key only it holds, and returns `{ status, headers, body }`. A proxy
 * refusal (`proxyRefusal`) is thrown rather than read as Clockify's answer.
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
 * The integration proxy's own refusals (`integration-proxy/src/api_error.rs`):
 * `{ error, message }` with one of these codes, answered before the provider
 * is called. The first group means the connection is gone or no longer this
 * app's, so the person has to connect again. `unsupported_authorization`
 * (a retired `Bearer` code) is left out: only a host from before #54 sends
 * one.
 */
const RECONNECT_CODES = [
  'unknown_connection',
  'not_delegated',
  'capability_scope',
  'platform_mismatch',
  'credential_refresh_failed',
];
const REFUSAL_CODES = [
  ...RECONNECT_CODES,
  'missing_signature',
  'unsupported_signature_version',
  'invalid_agent',
  'agent_key_mismatch',
  'stale_timestamp',
  'bad_signature',
  'replayed',
  'invalid_capability',
  'capability_expired',
  'capability_too_long',
  'wrong_audience',
  'capability_key_mismatch',
  'not_owner',
  'access_denied',
];

/** A proxy refusal as an error, or `undefined` for a provider answer. */
export function proxyRefusal(response: {
  status: number;
  body: unknown;
}): Error | undefined {
  const body = response.body as { error?: unknown; message?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : undefined;
  if (response.status < 400 || !code || !REFUSAL_CODES.includes(code))
    return undefined;
  const detail = typeof body?.message === 'string' ? `: ${body.message}` : '';

  return new Error(
    RECONNECT_CODES.includes(code)
      ? `The integration proxy refused this connection (${code}${detail}). Connect again.`
      : `The integration proxy refused the request (${code}${detail}).`,
  );
}

/**
 * The transport for one connection, over the host. There is intentionally no
 * frame-side credential of any kind: the frame is null-origin, has no
 * storage, and a resource must not carry a credential (#21).
 */
export function relayTransport(
  proxy: HostProxy,
  connection: ConnectionReference,
): ProxyTransport {
  return {
    async request(path, query) {
      const response = await proxy.request({
        platform: connection.platform,
        connectionId: connection.connectionId,
        path,
        method: 'GET',
        ...(query ? { query } : {}),
      });
      const refused = proxyRefusal(response);
      if (refused) throw refused;

      return response;
    },
  };
}
