// @wc-ignore-file
import type { Transport } from 'syncables/browser';
import type { HostProxy } from './store.js';

export const PLATFORM = 'notion';

/**
 * syncables' injected transport, over the host's proxy relay. syncables
 * builds absolute URLs under the document's server
 * (`https://api.notion.com/v1`). The relay wants the provider path after
 * `/proxy/notion`, which keeps the `/v1` base path (integration-proxy only
 * allows `/v1/search`, not `/search`). Anything outside that server is refused
 * before it reaches the host.
 *
 * The relay parses a JSON response body; syncables wants text, so it is
 * serialised again. Notion's list bodies are small, capped at 100 results.
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
