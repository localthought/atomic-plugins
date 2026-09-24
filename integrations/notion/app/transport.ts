// @wc-ignore-file
import type { Transport } from 'syncables/browser';
import type { HostProxy } from './store.js';

export const PLATFORM = 'notion';

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
 * syncables' injected transport, over the host's `store.proxy.request` (the
 * host's frame client calls the proxy itself with a capability and its own
 * key, ontola/atomic-plugins#54). syncables builds absolute URLs under the
 * document's server (`https://api.notion.com/v1`). The proxy wants the
 * provider path after `/proxy/<connection>/notion`, which keeps the `/v1`
 * base path (integration-proxy only allows `/v1/search`, not `/search`).
 * Anything outside that server is refused before it reaches the host.
 *
 * The host parses a JSON response body; syncables wants text, so it is
 * serialised again. Notion's list bodies are small, capped at 100 results.
 * A proxy refusal is thrown rather than handed over as Notion's answer.
 */
export function syncablesTransport(
  proxy: HostProxy,
  connectionId: string,
  upstream: URL,
): Transport {
  const base = upstream.pathname.replace(/\/$/, '');

  return async request => {
    const { url } = request;
    if (
      url.origin !== upstream.origin ||
      (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(`Refusing a request outside ${upstream.href}`);

    const response = await proxy.request({
      platform: PLATFORM,
      connectionId,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      ...(request.body === undefined ? {} : { body: request.body }),
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
