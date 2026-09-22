import { sleep } from './events-client.js';

/**
 * A record as stored on a platform. For the Calendar case this is an event
 * ({ id, summary, start, end, extendedProperties, ... }).
 */
export type PlatformRecord = Record<string, unknown>;

export interface FakePlatformOptions {
  /** Label for diagnostics. */
  name?: string;
  /**
   * Artificial delay applied to each write before it is stored, to simulate a
   * slow platform. (Reflection latency that the reviewer must poll through is
   * modelled on the reflector side instead — see StubReflector.)
   */
  writeLatencyMs?: number;
  /** When true every write responds 500, to drive the retry/rollback paths. */
  failWrites?: boolean;
}

/**
 * An in-memory stand-in for ONE remote system of record (e.g. a calendar
 * provider), addressed exactly like the real API so a syncables client can't
 * tell the difference. Holds events per `calendarId`.
 *
 * This is the harness's platform seam: to run against a real system, drop this
 * and hand the roles a `fetch` bound to real credentials + base URL instead.
 */
export class FakePlatform {
  readonly name: string;
  private readonly latency: number;
  private readonly failWrites: boolean;
  private readonly calendars = new Map<string, Map<string, PlatformRecord>>();

  constructor(options: FakePlatformOptions = {}) {
    this.name = options.name ?? 'platform';
    this.latency = options.writeLatencyMs ?? 0;
    this.failWrites = options.failWrites ?? false;
  }

  private store(calendarId: string): Map<string, PlatformRecord> {
    let s = this.calendars.get(calendarId);
    if (!s) {
      s = new Map();
      this.calendars.set(calendarId, s);
    }
    return s;
  }

  /** Direct read, bypassing syncables — for cleanup and independent inspection. */
  events(calendarId: string): PlatformRecord[] {
    return [...this.store(calendarId).values()].map((e) => structuredClone(e));
  }

  /** Pre-populate a calendar with state that must survive a run untouched. */
  seed(calendarId: string, events: PlatformRecord[]): void {
    const s = this.store(calendarId);
    for (const e of events) {
      s.set(String(e['id']), structuredClone(e));
    }
  }

  /** Direct delete, bypassing syncables — for teardown. */
  deleteDirect(calendarId: string, id: string): void {
    this.store(calendarId).delete(id);
  }

  /**
   * A `fetch` bound to one calendar, routing syncables' requests into this
   * platform's store. It fills the `{calendarId}` path template (the app's
   * real `authorizedFetch` does the same) and matches the events collection
   * and item routes regardless of any server base-path prefix.
   */
  fetchFor(calendarId: string): typeof fetch {
    const impl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const { path, search } = resolvePath(input, calendarId);
      const method = (init?.method ?? 'GET').toUpperCase();
      const store = this.store(calendarId);

      const itemMatch = /\/calendars\/[^/]+\/events\/([^/]+)$/.exec(path);
      const listMatch = /\/calendars\/[^/]+\/events\/?$/.test(path);

      if (listMatch) {
        if (method === 'POST') {
          return this.write(store, init, (body) => {
            store.set(String(body['id']), body);
            return body;
          });
        }
        // GET list: single page, terminated by a sync token.
        const items = [...store.values()].map((e) => structuredClone(e));
        void search;
        return json({ items, nextSyncToken: 'SYNC' });
      }

      if (itemMatch) {
        const id = decodeURIComponent(itemMatch[1] as string);
        if (method === 'PUT' || method === 'PATCH') {
          return this.write(store, init, (body) => {
            const merged =
              method === 'PATCH'
                ? { ...(store.get(id) ?? {}), ...body, id }
                : { ...body, id };
            store.set(id, merged);
            return merged;
          });
        }
        if (method === 'DELETE') {
          if (this.failWrites) {
            return json({ error: 'write rejected' }, 500);
          }
          if (this.latency) {
            await sleep(this.latency);
          }
          store.delete(id);
          return new Response(null, { status: 204 });
        }
        const found = store.get(id);
        return found
          ? json(structuredClone(found))
          : json({ error: 'not found' }, 404);
      }

      return json({ error: `unroutable ${method} ${path}` }, 404);
    };
    return impl as typeof fetch;
  }

  /** Applies a create/update body through `apply`, honoring latency + failure. */
  private async write(
    _store: Map<string, PlatformRecord>,
    init: RequestInit | undefined,
    apply: (body: PlatformRecord) => PlatformRecord,
  ): Promise<Response> {
    if (this.failWrites) {
      return json({ error: 'write rejected' }, 500);
    }
    if (this.latency) {
      await sleep(this.latency);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as PlatformRecord;
    return json(apply(body));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Fills `{calendarId}` and returns the request path + query, prefix-agnostic. */
function resolvePath(
  input: RequestInfo | URL,
  calendarId: string,
): { path: string; search: URLSearchParams } {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const url = new URL(raw);
  const enc = encodeURIComponent(calendarId);
  // `new URL()` percent-encodes the `{`/`}` of an unfilled template variable,
  // so match both the literal and the encoded forms (as authed-fetch does).
  const path = url.pathname
    .replaceAll('{calendarId}', enc)
    .replaceAll('%7BcalendarId%7D', enc)
    .replaceAll('%7bcalendarId%7d', enc);
  return { path, search: url.searchParams };
}
