import {
  refreshTokens,
  type AuthProfile,
  type OAuthClient,
  type OAuthTokens,
} from './oauth.js';

/**
 * Placeholder origin used for the `baseUrl` handed to the syncables client.
 * syncables builds request URLs by joining a path template onto this origin;
 * `authorizedFetch` then throws the origin away and rebuilds the URL against
 * the real API base (from the document's `servers`), so its value only has to
 * be a valid, absolute origin.
 */
export const SYNCABLES_BASE_URL = 'https://api.reflector.local';

export type PathParams = Record<string, string>;

/**
 * Anything that can hand the syncables client a `fetch` bound to a connected
 * account's credentials. Both the OAuth {@link TokenManager} and the static
 * {@link StaticTokenManager} implement it, so the sync/reflection layers don't
 * care which auth style an endpoint uses.
 */
export interface AuthorizedFetcher {
  authorizedFetch(params?: PathParams): typeof fetch;
}

/**
 * Owns a connected account's token set, refreshing it as it nears expiry and
 * handing out `fetch` implementations for the syncables client to use. It is
 * driven entirely by an {@link AuthProfile}, so it targets whatever API the
 * OpenAPI document describes — there is nothing provider-specific here.
 */
export class TokenManager implements AuthorizedFetcher {
  private tokens: OAuthTokens;
  private refreshing: Promise<OAuthTokens> | undefined;

  constructor(
    private readonly profile: AuthProfile,
    private readonly client: OAuthClient,
    tokens: OAuthTokens,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onChange?: (tokens: OAuthTokens) => void,
  ) {
    this.tokens = tokens;
  }

  current(): OAuthTokens {
    return this.tokens;
  }

  update(tokens: OAuthTokens): void {
    this.tokens = tokens;
    this.onChange?.(tokens);
  }

  /** Returns a valid access token, refreshing first if it is expired or about to expire. */
  private async validAccessToken(force = false): Promise<string> {
    const expiringSoon = this.tokens.expiresAt - Date.now() < 60_000;
    if (force || expiringSoon) {
      // Collapse concurrent refreshes (many requests can race during a sync).
      this.refreshing ??= refreshTokens(
        this.profile,
        this.client,
        this.tokens,
        this.fetchImpl,
      )
        .then((next) => {
          this.update(next);
          return next;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
      await this.refreshing;
    }
    return this.tokens.accessToken;
  }

  /**
   * Builds a `fetch` for the syncables client. Every request it issues is
   * rewritten: the path template's `{...}` variables are filled from `params`
   * (e.g. `calendarId`), the request is retargeted at the real API base, and a
   * bearer token is attached. A 401 triggers a single forced token refresh and
   * retry.
   */
  authorizedFetch(params: PathParams = {}): typeof fetch {
    const run = async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      force: boolean,
    ): Promise<Response> => {
      const token = await this.validAccessToken(force);
      const target = this.resolveUrl(input, params);
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return this.fetchImpl(target, { ...init, headers });
    };

    const authorized = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const response = await run(input, init, false);
      if (response.status === 401 && this.tokens.refreshToken) {
        return run(input, init, true);
      }
      return response;
    };

    return authorized as typeof fetch;
  }

  /** Rewrites a syncables-issued URL into a concrete API URL against the profile's base. */
  private resolveUrl(input: RequestInfo | URL, params: PathParams): string {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = new URL(raw);
    let path = url.pathname;
    for (const [key, value] of Object.entries(params)) {
      const encoded = encodeURIComponent(value);
      // `new URL()` percent-encodes the `{`/`}` of an unfilled `{calendarId}`
      // template variable, so match both the literal and encoded forms.
      path = path
        .replaceAll(`{${key}}`, encoded)
        .replaceAll(`%7B${key}%7D`, encoded)
        .replaceAll(`%7b${key}%7d`, encoded);
    }
    return `${this.profile.apiBase}${path}${url.search}`;
  }
}
