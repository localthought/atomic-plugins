// @wc-ignore-file
/**
 * `adapter.ts` reads and writes through `Host.read(intent)` with absolute
 * Google URLs. In the drive app that becomes one `store.proxy.request` per
 * intent, for platform `google-calendar`: the host's frame client calls the
 * integration proxy itself, with a capability the page signed and a key only
 * it holds (ontola/atomic-plugins#54). The file keeps its old name, "relay".
 *
 * The proxy wants the provider path after `/proxy/<connection>/google-calendar`.
 * The integration-proxy strips its catalog server's base path (`/calendar/v3`)
 * itself, so the path keeps it: `/calendar/v3/calendars/{id}/events`.
 * Anything outside `https://www.googleapis.com/calendar/v3/` is refused here,
 * before it reaches the host.
 *
 * The adapter's `Authorization: secret:google-calendar` header is the
 * sandbox runtime's credential placeholder. It is dropped: the frame never
 * names a credential, only a connection id. `If-Match` becomes the request's
 * `ifMatch` field; no other request header crosses to the proxy.
 */
import type {
  ExternalIntent,
  ExternalReceipt,
} from '../../../browser/lib/src/plugin-connection.js';
import type { HostProxy, HostProxyResponse } from './store.js';

export const PLATFORM = 'google-calendar';
export const UPSTREAM = 'https://www.googleapis.com/calendar/v3';

/**
 * The call for a write threw instead of answering (a lost response, a
 * timeout). It may have reached Google, so Google may or may not have
 * applied it. Nothing about the event is assumed: the next preview reads
 * what Google has.
 */
export class UncertainWriteError extends Error {
  constructor(
    readonly id: string,
    readonly cause: unknown,
  ) {
    super(
      `Google may or may not have applied this change (${
        cause instanceof Error ? cause.message : String(cause)
      }). Refresh to see what Google has now.`,
    );
  }
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

export interface Relayed {
  /** The most recent relay response (for `retry-after` on a 429). */
  last?: HostProxyResponse;
  read(intent: ExternalIntent): Promise<ExternalReceipt>;
}

function relayPath(href: string): {
  path: string;
  query: Record<string, string>;
} {
  const url = new URL(href);
  const base = new URL(UPSTREAM);

  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname}/`) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(`Refusing a request outside ${UPSTREAM}: ${url.href}`);

  return {
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  };
}

export function relay(proxy: HostProxy, connectionId: string): Relayed {
  const out: Relayed = {
    async read(intent) {
      const { path, query } = relayPath(intent.url);
      const method = intent.method.toUpperCase();
      if (method !== 'GET' && method !== 'PATCH')
        throw new Error(`The Calendar app does not send ${method} requests`);
      const ifMatch = intent.headers?.['If-Match'];
      if (method === 'PATCH' && !ifMatch)
        throw new Error('Refusing a Calendar write without If-Match');
      let response: HostProxyResponse;

      try {
        response = await proxy.request({
          platform: PLATFORM,
          connectionId,
          path,
          method,
          ...(Object.keys(query).length ? { query } : {}),
          ...(intent.body === undefined ? {} : { body: intent.body }),
          ...(ifMatch ? { ifMatch } : {}),
        });
      } catch (error) {
        if (method === 'GET') throw error;
        throw new UncertainWriteError(intent.id, error);
      }

      out.last = response;
      // Answered by the proxy itself, before Google: certainly not applied.
      const refused = proxyRefusal(response);
      if (refused) throw refused;

      return {
        status: response.status,
        body:
          typeof response.body === 'string'
            ? response.body
            : JSON.stringify(response.body ?? null),
      };
    },
  };

  return out;
}

export interface CalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  /** Google's `accessRole`: owner, writer, reader or freeBusyReader. */
  accessRole: string;
}

/** The person's calendar list, every page (at most 10 pages of 250). */
export async function listCalendars(
  proxy: HostProxy,
  connectionId: string,
): Promise<CalendarEntry[]> {
  const host = relay(proxy, connectionId);
  const out: CalendarEntry[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    if (++pages > 10)
      throw new Error('More than 2,500 calendars; the list was not read');
    const url = new URL(`${UPSTREAM}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const receipt = await host.read({
      id: `calendar-list-${pages}`,
      operation: 'calendar-list',
      method: 'GET',
      url: url.href,
    });
    if (receipt.status < 200 || receipt.status >= 300)
      throw new Error(`Google Calendar returned ${receipt.status}`);
    const page = JSON.parse(receipt.body) as {
      items?: Array<Partial<CalendarEntry> & { id?: unknown }>;
      nextPageToken?: string;
    };
    if (!Array.isArray(page.items))
      throw new Error('Google Calendar list page must include an items array');

    for (const item of page.items)
      if (typeof item.id === 'string' && item.id)
        out.push({
          id: item.id,
          summary: typeof item.summary === 'string' ? item.summary : item.id,
          primary: item.primary === true,
          accessRole:
            typeof item.accessRole === 'string' ? item.accessRole : 'reader',
        });

    pageToken = page.nextPageToken;
  } while (pageToken);

  return out;
}
