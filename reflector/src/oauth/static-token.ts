import type { AuthorizedFetcher, PathParams } from './authed-fetch.js';

/**
 * Authenticates with a single long-lived token instead of an OAuth flow.
 *
 * This is what a GitHub personal-access / installation token needs: the token
 * is a static secret sent as `Authorization: Bearer <token>` on every request,
 * with no authorization redirect and no refresh. Like {@link TokenManager} it
 * rewrites each syncables-issued request — filling `{...}` path variables
 * (e.g. `{owner}`/`{repo}`), retargeting it at the real API base — but there is
 * no token lifecycle to manage, so a 401 is surfaced rather than retried.
 *
 * Nothing here is GitHub-specific; it is driven by the API base derived from
 * the document's `servers` plus the configured token.
 */
export class StaticTokenManager implements AuthorizedFetcher {
  constructor(
    /** Root of the real API, from the document's `servers` (e.g. `https://api.github.com`). */
    private readonly apiBase: string,
    /** The static bearer token (a secret). */
    private readonly token: string,
    /** Auth scheme prefix; `Bearer` suits GitHub PATs and most token APIs. */
    private readonly scheme: string = 'Bearer',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizedFetch(params: PathParams = {}): typeof fetch {
    const authorized = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const target = this.resolveUrl(input, params);
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `${this.scheme} ${this.token}`);
      return this.fetchImpl(target, { ...init, headers });
    };
    return authorized as typeof fetch;
  }

  /** Rewrites a syncables-issued URL into a concrete API URL against the API base. */
  private resolveUrl(input: RequestInfo | URL, params: PathParams): string {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = new URL(raw);
    let path = url.pathname;
    for (const [key, value] of Object.entries(params)) {
      const encoded = encodeURIComponent(value);
      // `new URL()` percent-encodes the braces of an unfilled `{owner}`
      // template variable, so match both the literal and encoded forms.
      path = path
        .replaceAll(`{${key}}`, encoded)
        .replaceAll(`%7B${key}%7D`, encoded)
        .replaceAll(`%7b${key}%7d`, encoded);
    }
    return `${this.apiBase}${path}${url.search}`;
  }
}
