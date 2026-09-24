// @wc-ignore-file
/** Google Calendar-specific mapping; the host owns credentials, effects and persistence. */
import {
  reconcileRecord,
  type SyncRecord,
} from '../../browser/lib/src/plugin-reconcile.js';
import type {
  ConnectionState,
  ExternalIntent,
  ExternalReceipt,
} from '../../browser/lib/src/plugin-connection.js';

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface Event {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  recurrence?: string[];
  recurringEventId?: string;
  etag: string;
}
export type Projection = {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
};
export interface Card {
  subject: string;
  id?: string;
  value: Projection;
}
export interface Host {
  read(intent: ExternalIntent): Promise<ExternalReceipt>;
  cards(): Promise<Card[]>;
  state(): Promise<ConnectionState>;
}

export interface Change {
  subject?: string;
  id?: string;
  local?: Projection;
  remote?: Projection;
  desired: Projection;
  /** The event's ETag as read in this preview; an edit sent later is conditioned on it. */
  etag?: string;
}
export interface Preview {
  calendarId: string;
  revision: number;
  changes: Change[];
  conflicts: Array<{
    subject?: string;
    id?: string;
    fields: string[];
    /** Both-changed conflicts only: the three sides, and the ETag read, so a
     * person can choose per field (the choice is sent later, reviewed). */
    local?: Projection;
    remote?: Projection;
    base?: Projection;
    etag?: string;
  }>;
  /** Events read but not imported, by reason. A cancelled instance of a
   * series counts as recurring. */
  skipped: { recurring: number; cancelled: number };
}

/** Google answered a conditional write with 412: the event changed after the
 * preview that the edit was planned from. Nothing was written. */
export class StaleEventError extends Error {
  constructor(readonly id: string) {
    super('Google event changed after preview; preview again');
  }
}

/** 250 events per page; the default cap of 100 pages is 25,000 events. */
export const PAGE_SIZE = 250;
export const MAX_PAGES = 100;

const headers = {
  Authorization: 'secret:google-calendar',
  'Content-Type': 'application/json',
};

function civilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);

  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function offsetDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Series and instances are out of scope for this pilot; the host skips them
 * rather than mapping a partial view of a recurring event. Cancelled events
 * are skipped the same way, never treated as evidence of a completed sync. */
export function project(event: Event): Projection | undefined {
  if (event.recurrence?.length || event.recurringEventId) return undefined;
  if (event.status === 'cancelled') return undefined;
  if (typeof event.id !== 'string' || !event.id)
    throw new Error('Google returned an invalid event');
  const allDay = typeof event.start.date === 'string';

  if (allDay) {
    if (
      event.start.dateTime !== undefined ||
      event.end.dateTime !== undefined ||
      !event.start.date ||
      !civilDate(event.start.date) ||
      !event.end.date ||
      !civilDate(event.end.date) ||
      event.end.date <= event.start.date
    )
      throw new Error(
        `Calendar event ${event.id} has an invalid all-day interval`,
      );
  } else {
    if (
      event.start.date !== undefined ||
      event.end.date !== undefined ||
      typeof event.start.dateTime !== 'string' ||
      !offsetDateTime(event.start.dateTime) ||
      typeof event.end.dateTime !== 'string' ||
      !offsetDateTime(event.end.dateTime) ||
      Date.parse(event.end.dateTime) <= Date.parse(event.start.dateTime)
    )
      throw new Error(
        `Calendar event ${event.id} has an invalid timed interval`,
      );
  }

  return {
    title: event.summary ?? '',
    description: event.description ?? '',
    location: event.location ?? '',
    start: allDay ? event.start.date! : event.start.dateTime!,
    end: allDay ? event.end.date! : event.end.dateTime!,
    allDay,
  };
}

function validate(value: Projection) {
  if (typeof value.title !== 'string' || !value.title.trim())
    throw new Error('Events require a non-empty title');
  if (
    typeof value.description !== 'string' ||
    typeof value.location !== 'string'
  )
    throw new Error('Description and location must be text');
  if (typeof value.allDay !== 'boolean')
    throw new Error('allDay must be a boolean');
  const valid = value.allDay ? civilDate : offsetDateTime;
  if (!valid(value.start) || !valid(value.end))
    throw new Error(
      value.allDay
        ? 'All-day events need plain YYYY-MM-DD dates'
        : 'Timed events need an explicit UTC offset',
    );
  const parseDate = (d: string) =>
    value.allDay ? Date.parse(`${d}T00:00:00Z`) : Date.parse(d);
  if (parseDate(value.end) <= parseDate(value.start))
    throw new Error('Event end must follow its start');
}

export function endpoint(calendarId: string): string {
  if (
    !calendarId ||
    /[/?#]/.test(calendarId) ||
    ['.', '..'].includes(calendarId)
  )
    throw new Error('Calendar id must not contain path separators');

  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}
export function manifest(calendarId: string) {
  const url = endpoint(calendarId);

  return {
    schemaVersion: 1,
    actions: [
      {
        name: 'get_event',
        title: 'Get an event',
        description: 'Read one event from this connected calendar.',
        operation: 'get',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Google event id' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        name: 'create_event',
        title: 'Create an event',
        description:
          'Prepare a new event on this calendar for review. Nothing is sent until approved.',
        operation: 'create',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            description: { type: 'string', description: 'Event description' },
            start: {
              type: 'string',
              description: 'YYYY-MM-DD or an offset-qualified date-time',
            },
            end: {
              type: 'string',
              description: 'YYYY-MM-DD or an offset-qualified date-time',
            },
            allDay: {
              type: 'boolean',
              description: 'Whether this is an all-day event',
            },
          },
          required: ['title', 'start', 'end', 'allDay'],
          additionalProperties: false,
        },
      },
    ],
    secrets: [
      {
        name: 'google-calendar',
        origin: 'https://www.googleapis.com',
        description:
          'Google OAuth token with Calendar events read/write access to this calendar',
      },
    ],
    operations: [
      { id: 'list', method: 'GET', url, effect: 'read' },
      { id: 'get', method: 'GET', url: `${url}/{id}`, effect: 'read' },
      { id: 'create', method: 'POST', url, effect: 'write' },
      { id: 'update', method: 'PATCH', url: `${url}/{id}`, effect: 'write' },
    ],
  };
}

function parse<T>(response: ExternalReceipt): T {
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Google Calendar returned ${response.status}; no checkpoint was advanced. Resolve access/reconnect before retrying.`,
    );

  return JSON.parse(response.body) as T;
}

export function request(
  operation: string,
  method: string,
  url: string,
  id: string,
  body?: unknown,
  ifMatch?: string,
): ExternalIntent {
  return {
    operation,
    method,
    url,
    id,
    headers: ifMatch ? { ...headers, 'If-Match': ifMatch } : headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
export async function get(
  host: Host,
  root: string,
  id: string,
): Promise<Event> {
  const event = parse<Event>(
    await host.read(
      request('get', 'GET', `${root}/${encodeURIComponent(id)}`, 'read'),
    ),
  );
  if (event.id !== id)
    throw new Error('Expected an event with the requested id');

  return event;
}

/** Full scans avoid interpreting a partial page as deletion. A pilot cap fails loudly. */
export async function preview(
  host: Host,
  calendarId: string,
  { maxPages = MAX_PAGES }: { maxPages?: number } = {},
): Promise<Preview> {
  const root = endpoint(calendarId);
  const state = await host.state();
  if (state.cursor)
    throw new Error(
      'A saved sync is pending; resume it before previewing another run',
    );
  const events = new Map<string, Projection>();
  const etags = new Map<string, string>();
  const skipped = { recurring: 0, cancelled: 0 };
  let pageToken: string | undefined;
  let pages = 0;

  do {
    if (++pages > maxPages)
      throw new Error(
        `Pilot supports at most ${String(maxPages * PAGE_SIZE).replace(/\B(?=(\d{3})+$)/g, ',')} events per scan`,
      );
    const url = `${root}?singleEvents=false&showDeleted=true&maxResults=${PAGE_SIZE}${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    }`;
    const page = parse<{ items: Event[]; nextPageToken?: string }>(
      await host.read(request('list', 'GET', url, `page-${pages}`)),
    );
    if (!Array.isArray(page.items))
      throw new Error('Google Calendar event page must include an items array');

    for (const event of page.items) {
      const projection = project(event);

      if (projection) {
        events.set(event.id, projection);
        if (typeof event.etag === 'string') etags.set(event.id, event.etag);
      } else if (event.recurrence?.length || event.recurringEventId)
        skipped.recurring++;
      else skipped.cancelled++;
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  const cards = await host.cards();
  const byId = new Map<string, Card>();

  for (const card of cards) {
    validate(card.value);

    if (card.id !== undefined) {
      if (byId.has(card.id))
        throw new Error(`Duplicate cards for event ${card.id}`);
      byId.set(card.id, card);
    }
  }

  const result: Preview = {
    calendarId,
    revision: state.revision,
    changes: [],
    conflicts: [],
    skipped,
  };

  for (const [id, remote] of events) {
    const binding = state.records[id];
    const card = byId.get(id);

    if (binding && (!card || binding.local !== card.subject)) {
      result.conflicts.push({ id, fields: ['Missing or rebound local card'] });
      continue;
    }

    const decision = reconcileRecord(
      binding?.baseline as SyncRecord,
      card?.value,
      remote,
    );

    if (decision.conflicts.length) {
      result.conflicts.push({
        subject: card?.subject,
        id,
        fields: decision.conflicts.map(c => c.property),
        ...(card ? { local: card.value } : {}),
        remote,
        ...(binding?.baseline
          ? { base: binding.baseline as unknown as Projection }
          : {}),
        ...(etags.has(id) ? { etag: etags.get(id) } : {}),
      });
      continue;
    }

    const desired = { ...remote, ...decision.remote } as Projection;
    validate(desired);
    // Include unchanged records so their identity/baseline is established on first import.
    result.changes.push({
      subject: card?.subject,
      id,
      local: card?.value,
      remote,
      desired,
      etag: etags.get(id),
    });
  }

  for (const card of cards) {
    if (card.id === undefined)
      result.changes.push({
        subject: card.subject,
        local: card.value,
        desired: card.value,
      });
    else if (!events.has(card.id))
      result.conflicts.push({
        subject: card.subject,
        id: card.id,
        fields: [
          'Event cancelled, recurring or inaccessible; no deletion inferred',
        ],
      });
  }

  return result;
}

export interface Edit {
  id: string;
  subject?: string;
  patch: Partial<{
    summary: string;
    description: string;
    location: string;
    start: EventTime;
    end: EventTime;
  }>;
}

function eventTime(value: string, allDay: boolean): EventTime {
  return allDay ? { date: value } : { dateTime: value };
}

/** Only the fields a title/description/location/start/end edit actually
 * touches; never a full event replacement. */
export function planEdit(
  id: string,
  desired: Projection,
  remote: Projection,
  subject?: string,
): Edit | undefined {
  const patch: Edit['patch'] = {};
  if (desired.title !== remote.title) patch.summary = desired.title;
  if (desired.description !== remote.description)
    patch.description = desired.description;
  if (desired.location !== remote.location) patch.location = desired.location;
  if (desired.start !== remote.start || desired.allDay !== remote.allDay)
    patch.start = eventTime(desired.start, desired.allDay);
  if (desired.end !== remote.end || desired.allDay !== remote.allDay)
    patch.end = eventTime(desired.end, desired.allDay);
  if (!Object.keys(patch).length) return undefined;

  return { id, subject, patch };
}
/** Conditions the write on the ETag captured at preview time so a change to
 * the event in Google since then fails loudly instead of being overwritten. */
export async function applyEdit(
  host: Host,
  root: string,
  edit: Edit,
  etag: string,
): Promise<Event> {
  const response = await host.read(
    request(
      'update',
      'PATCH',
      `${root}/${encodeURIComponent(edit.id)}?sendUpdates=none`,
      'write',
      edit.patch,
      etag,
    ),
  );
  if (response.status === 412) throw new StaleEventError(edit.id);

  return parse<Event>(response);
}
