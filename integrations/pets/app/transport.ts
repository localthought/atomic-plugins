// @wc-ignore-file
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from 'syncables/browser';
import type { HostProxy } from './store.js';

/**
 * A syncables `Transport` that goes through the host's proxy relay.
 *
 * syncables builds absolute upstream URLs under the document's
 * `servers[0].url` (and follows `Link: rel="next"` URLs the provider sends).
 * The proxy wants the provider path after `/proxy/<platform>`, so the
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
