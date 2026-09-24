// @wc-ignore-file
/**
 * `adapter.ts` reads and writes through `Host.read(intent)` with absolute
 * Google URLs. In the drive app that becomes one call to the host's proxy
 * relay (`store.proxy.request`) per intent, for platform `google-calendar`.
 *
 * The relay wants the provider path after `/proxy/google-calendar`. The
 * integration-proxy strips its catalog server's base path (`/calendar/v3`)
 * itself, so the path keeps it: `/calendar/v3/calendars/{id}/events`.
 * Anything outside `https://www.googleapis.com/calendar/v3/` is refused here,
 * before it reaches the host.
 *
 * The adapter's `Authorization: secret:google-calendar` header is the
 * sandbox runtime's credential placeholder. It is dropped: the frame never
 * names a credential, only a connection id. `If-Match` becomes the relay's
 * `ifMatch` field; no other request header can cross the relay.
 */
import type {
  ExternalIntent,
  ExternalReceipt,
} from '../../../browser/lib/src/plugin-connection.js';
import type { HostProxy, HostProxyResponse } from './store.js';

export const PLATFORM = 'google-calendar';
export const UPSTREAM = 'https://www.googleapis.com/calendar/v3';

/**
 * The relay call for a write threw instead of answering. The host may have
 * sent it (the page spends its connection code before dispatch), so Google
 * may or may not have applied it. Nothing about the event is assumed: the
 * next preview reads what Google has.
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
