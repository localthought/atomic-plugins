// @wc-ignore-file
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from 'syncables/browser';
import type { HostProxy } from './store.js';

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
 * A syncables `Transport` over the host's `store.proxy.request`: the host's
 * frame client calls the integration proxy with a capability the page signed
 * and a key only it holds (ontola/atomic-plugins#54). A proxy refusal is
 * thrown, not handed to syncables as if Pets had answered.
 *
 * syncables builds absolute upstream URLs under the document's
 * `servers[0].url` (and follows `Link: rel="next"` URLs the provider sends).
 * The proxy wants the provider path after `/proxy/<connection>/<platform>`, so the
 * upstream base is stripped. Anything outside that base is refused here,
 * before it reaches the host: a provider-sent link must not be able to steer
 * the connection somewhere else.
 */
export function relayTransport(
  proxy: HostProxy,
  reference: { platform: string; connectionId: string },
  upstream: string,
): Transport {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/$/, '');

  return async (request: TransportRequest): Promise<TransportResponse> => {
    const { url } = request;

    if (
      url.origin !== base.origin ||
      (prefix !== '' &&
        url.pathname !== prefix &&
        !url.pathname.startsWith(`${prefix}/`))
    )
      throw new Error(`Refusing a request outside ${upstream}: ${url.href}`);

    const path = `${url.pathname.slice(prefix.length) || '/'}${url.search}`;
    const response = await proxy.request({
      ...reference,
      path,
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
    });

    const refused = proxyRefusal(response);
    if (refused) throw refused;

    return {
      status: response.status,
      headers: response.headers ?? {},
      body:
        typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body ?? null),
    };
  };
}
