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
 * Host errors raised before the frame sends anything to the proxy, so the
 * request certainly never left this browser: the page refusing to mint a
 * capability, the frame unable to make its key, or an invalid request
 * (atomic-server `helpers/proxyConnections.ts`, `chunks/AppPage/hostStore.ts`
 * and `view-client.js` at the pin). Matching on text is brittle; a message
 * that stops matching only makes a write look uncertain, which pauses sync
 * instead of resending it.
 */
const NOT_SENT = [
  /^No [a-z0-9-]+ connection .* is delegated to this app/,
  /^This host cannot reach the integration proxy/,
  /^This browser (has no WebCrypto|cannot make an Ed25519 key)/,
  /^The host returned no capability/,
  /^This app has no identity of its own yet/,
  /^The integration proxy refused (GET|POST|DELETE) \/connections/,
  /^Invalid (platform|proxy path|proxy method|proxy query|If-Match)/,
  /^A (GET )?proxy request/,
  /^(connectionId|publicKey|platform) is required/,
  /^Sign in/,
];

/**
 * The integration proxy's own refusals (`integration-proxy/src/api_error.rs`):
 * `{ error, message }` with one of these codes. The proxy answers them before
 * calling GitHub, so a refused write was not sent. The first group means the
 * connection is gone or no longer this app's: connect again.
 * `unsupported_authorization` (a retired `Bearer` code) is left out: only a
 * host from before #54 sends one.
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
}): (Error & { notSent: true }) | undefined {
  const body = response.body as { error?: unknown; message?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : undefined;
  if (response.status < 400 || !code || !REFUSAL_CODES.includes(code))
    return undefined;
  const detail = typeof body?.message === 'string' ? `: ${body.message}` : '';

  return Object.assign(
    new Error(
      RECONNECT_CODES.includes(code)
        ? `The integration proxy refused this connection (${code}${detail}). Connect again.`
        : `The integration proxy refused the request (${code}${detail}).`,
    ),
    { notSent: true as const },
  );
}

/**
 * `proxyTransport`'s `dispatch` over the host's `store.proxy.request`. The
 * frame names the connection; the host's frame client calls the proxy with a
 * capability the page signed and a key it holds itself, and returns status,
 * a few headers and the body. This module never sees or stores a
 * credential.
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

    const refused = proxyRefusal(response);
    if (refused) throw refused;

    return {
      status: response.status,
      body:
        typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body ?? null),
    };
  };
}

/** One repository the connection can see, for the picker. */
export interface Repository {
  fullName: string;
  /** GitHub's `open_issues_count`, which counts open pull requests too. */
  openIssues?: number;
  /** `has_issues: false` repositories cannot be chosen. */
  hasIssues: boolean;
  private?: boolean;
}

/** At most this many pages of 100; more is not listed (type it instead). */
export const REPOSITORY_PAGES = 5;

/**
 * `GET /user/repos` through the relay, for the repository picker. A read,
 * outside the Bridge and its journal, and the only path besides `/repos/`
 * the app asks the host for. The proxy's GitHub Issues document may not
 * include it (atomic-plugins overlays, not verified): any failure rejects,
 * and the view falls back to typing `owner/name`.
 */
export async function listRepositories(
  proxy: HostProxy,
  connectionId: string,
): Promise<Repository[]> {
  const out: Repository[] = [];

  for (let page = 1; page <= REPOSITORY_PAGES; page++) {
    const response = await proxy.request({
      platform: PLATFORM,
      connectionId,
      path: '/user/repos',
      method: 'GET',
      query: { per_page: '100', page: String(page), sort: 'updated' },
    });
    const refused = proxyRefusal(response);
    if (refused) throw refused;
    if (response.status < 200 || response.status >= 300)
      throw new Error(`GitHub list_repositories returned ${response.status}`);
    const body =
      typeof response.body === 'string'
        ? (JSON.parse(response.body) as unknown)
        : response.body;
    if (!Array.isArray(body))
      throw new Error('GitHub returned no repository list');

    for (const raw of body as Record<string, unknown>[]) {
      if (typeof raw?.full_name !== 'string') continue;
      out.push({
        fullName: raw.full_name,
        hasIssues: raw.has_issues !== false,
        ...(Number.isSafeInteger(raw.open_issues_count)
          ? { openIssues: raw.open_issues_count as number }
          : {}),
        ...(typeof raw.private === 'boolean' ? { private: raw.private } : {}),
      });
    }

    if (body.length < 100) break;
  }

  return out;
}
