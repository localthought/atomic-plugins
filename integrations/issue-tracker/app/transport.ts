// @wc-ignore-file
import type { HostProxy } from './store.js';

/** The integration proxy's platform id for GitHub issues. */
export const PLATFORM = 'github-issues';

/** What `proxyTransport`'s `dispatch` hook resolves to. */
export interface Receipt {
  status: number;
  /** Response body as JSON text; `GitHubPort` parses it. */
  body: string;
}

export type Dispatch = (
  path: string,
  init: { method: string; body?: string },
) => Promise<Receipt>;

/**
 * Host errors that are raised before the relay spends a connection code, so
 * the request certainly never left this browser (atomic-server
 * `helpers/proxyConnections.ts` and `chunks/AppPage/hostStore.ts` at the
 * pin). Matching on text is brittle; a message that stops matching only makes
 * a write look uncertain, which pauses sync instead of resending it.
 */
const NOT_SENT = [
  /^No [a-z0-9-]+ connection for this app/,
  /^Reconnect before retrying an uncertain request/,
  /^This host cannot reach the integration proxy/,
  /^This browser needs Web Locks/,
  /^Invalid (platform|proxy path|proxy method|proxy query|If-Match)/,
  /^A (GET )?proxy request/,
  /^connectionId is required/,
  /^Sign in/,
];

/**
 * `proxyTransport`'s `dispatch` over the host's relay (`store.proxy.request`).
 * The frame names the connection; the host page holds and rotates its code,
 * serialises calls per connection and returns status and body only. This
 * module never sees or stores a credential.
 *
 * `path` comes from the GitHub adapter as `/repos/{owner}/{name}/issues…`
 * with its query string; it is split into the relay's `path` and `query`,
 * and anything outside `/repos/` is refused before it reaches the host.
 */
export function relayDispatch(
  proxy: HostProxy,
  connectionId: string,
): Dispatch {
  return async (path, { method, body }) => {
    const url = new URL(path, 'https://api.github.com');

    if (
      url.origin !== 'https://api.github.com' ||
      !url.pathname.startsWith('/repos/') ||
      url.hash
    ) {
      throw Object.assign(
        new Error(`Refusing a request outside /repos/: ${path}`),
        {
          notSent: true,
        },
      );
    }

    let response;

    try {
      response = await proxy.request({
        platform: PLATFORM,
        connectionId,
        path: url.pathname,
        method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
        ...(url.search ? { query: Object.fromEntries(url.searchParams) } : {}),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), {
        notSent: NOT_SENT.some(pattern => pattern.test(message)),
      });
    }

    return {
      status: response.status,
      body:
        typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body ?? null),
    };
  };
}
