// @wc-ignore-file
/**
 * The Calendar app's table: one row per imported Google event, under the
 * app's own table, which is all a view may write.
 *
 * `adapter.ts` owns the Google side (paging, skip rules, three-way
 * reconciliation, minimal ETag-conditioned patches). This file only maps its
 * `Card`/`ConnectionState` onto rows:
 *
 * - The five mapped fields are ordinary columns: Name (title), Description,
 *   Location, Start, End, All day. Start and End are the exact strings
 *   Google sent (`YYYY-MM-DD`, or a date-time with its UTC offset), never
 *   parsed into numbers or `Date`s for storage.
 * - Day (a `date` column) is the civil date of Start, so the host table's
 *   own Calendar view can place the row. It is derived on import and never
 *   read back: move an event by editing Start and End.
 * - The binding lives on the row, not in a separate store: the Google event
 *   id, the ETag last read, and the baseline — the projection both sides
 *   last agreed on, as JSON text. The baseline is what lets a refresh tell a
 *   local edit from a Google edit, and report both-changed as a conflict
 *   instead of overwriting either (adapter.ts, `reconcileRecord`).
 *
 * Nothing is sent to Google here except from `send()`, and only edits a
 * preview planned, each conditioned on the ETag that preview read.
 */
import {
  applyEdit,
  endpoint,
  planEdit,
  preview,
  project,
  StaleEventError,
  type Card,
  type Edit,
  type Host,
  type Preview,
  type Projection,
} from '../adapter.js';
import { relay, UncertainWriteError } from './relay.js';
import type {
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const PROPERTIES = `${A}/properties/properties`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
const DT = `${A}/datatypes`;

interface Spec {
  name: string;
  datatype: string;
  description: string;
  /** Shown as a table column (in the row class's `recommends`). */
  column: boolean;
}

/** Shortname -> Property. Created under the app's ontology on first import. */
export const SPECS: Record<string, Spec> = {
  location: {
    name: 'Location',
    datatype: `${DT}/string`,
    description: 'Where the event takes place, as Google Calendar has it.',
    column: true,
  },
  start: {
    name: 'Start',
    datatype: `${DT}/string`,
    description:
      'YYYY-MM-DD for an all-day event, otherwise a date-time with its UTC offset.',
    column: true,
  },
  end: {
    name: 'End',
    datatype: `${DT}/string`,
    description:
      'Exclusive: the day after the last day for an all-day event, otherwise a date-time with its UTC offset.',
    column: true,
  },
  'all-day': {
    name: 'All day',
    datatype: `${DT}/boolean`,
    description: 'Whether Start and End are dates rather than date-times.',
    column: true,
  },
  day: {
    name: 'Day',
    datatype: `${DT}/date`,
    description:
      'The date of Start, for calendar views. Derived on import; edit Start to move the event.',
    column: true,
  },
  'google-event-id': {
    name: 'Google event id',
    datatype: `${DT}/string`,
    description: 'The Google Calendar event this row is bound to.',
    column: false,
  },
  'google-etag': {
    name: 'Google ETag',
    datatype: `${DT}/string`,
    description: 'The event version last read from Google Calendar.',
    column: false,
  },
  'sync-baseline': {
    name: 'Sync baseline',
    datatype: `${DT}/string`,
    description:
      'JSON of the fields as both sides last agreed; tells local edits from Google edits.',
    column: false,
  },
  'google-calendar-id': {
    name: 'Google calendar id',
    datatype: `${DT}/string`,
    description: 'The one Google calendar this table imports (on the table).',
    column: false,
  },
};

export type Props = Record<keyof typeof SPECS, string>;

export interface Layout {
  table: string;
  rowClass: string;
  ontology: string;
}

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

export async function layout(store: PluginStore): Promise<Layout> {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to sync into.');
  const klass = await store.getResource(data.rowClass);
  const ontology = klass.get(PARENT);
  if (typeof ontology !== 'string')
    throw new Error('The row class has no parent ontology to add fields to.');

  return { table: data.table, rowClass: data.rowClass, ontology };
}

/** The existing Properties, by shortname; `create` adds the missing ones. */
export async function properties(
  store: PluginStore,
  where: Layout,
  create: boolean,
): Promise<Props | undefined> {
  const ontology = await store.getResource(where.ontology);
  const listed = asList(ontology.get(PROPERTIES));
  const found = new Map<string, string>();

  for (const subject of listed) {
    const shortname = (await store.getResource(subject)).get(SHORTNAME);
    if (typeof shortname === 'string') found.set(shortname, subject);
  }

  const missing = Object.keys(SPECS).filter(s => !found.has(s));
  if (missing.length && !create) return undefined;
  const created: string[] = [];

  for (const shortname of missing) {
    const spec = SPECS[shortname];
    const property = await store.newResource({
      parent: where.ontology,
      isA: [PROPERTY_CLASS],
      propVals: {
        [SHORTNAME]: shortname,
        [NAME]: spec.name,
        [DESCRIPTION]: spec.description,
        [DATATYPE]: spec.datatype,
      },
    });
    found.set(shortname, property.subject);
    created.push(property.subject);
  }

  if (created.length)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  const props = Object.fromEntries(
    Object.keys(SPECS).map(s => [s, found.get(s)!]),
  ) as Props;

  const klass = await store.getResource(where.rowClass);
  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [
    NAME,
    DESCRIPTION,
    ...Object.keys(SPECS)
      .filter(s => SPECS[s].column)
      .map(s => props[s]),
  ];
  const merged = [
    ...recommends,
    ...wanted.filter(s => !recommends.includes(s)),
  ];
  if (merged.length !== recommends.length || klass.get(NAME) !== 'Event')
    await klass.set(RECOMMENDS, merged).set(NAME, 'Event').save();

  return props;
}

/** The calendar this table imports, once chosen. */
export async function chosenCalendar(
  store: PluginStore,
): Promise<string | undefined> {
  const where = await layout(store);
  const props = await properties(store, where, false);
  if (!props) return undefined;
  const value = (await store.getResource(where.table)).get(
    props['google-calendar-id'],
  );

  return typeof value === 'string' && value ? value : undefined;
}

/** Binds the table to one calendar. A table never switches calendars. */
export async function chooseCalendar(
  store: PluginStore,
  calendar: { id: string; summary: string },
): Promise<void> {
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  const table = await store.getResource(where.table);
  const current = table.get(props['google-calendar-id']);
  if (typeof current === 'string' && current && current !== calendar.id)
    throw new Error(
      'This table already imports another calendar. Use a new Calendar app for a second one.',
    );
  await table
    .set(props['google-calendar-id'], calendar.id)
    .set(NAME, calendar.summary)
    .save();
}

const text = (value: JSONValue): string =>
  typeof value === 'string' ? value : '';

function cardOf(row: PluginResource, props: Props): Card {
  const id = row.get(props['google-event-id']);

  return {
    subject: row.subject,
    ...(typeof id === 'string' && id ? { id } : {}),
    value: {
      title: text(row.get(NAME)),
      description: text(row.get(DESCRIPTION)),
      location: text(row.get(props.location)),
      start: text(row.get(props.start)),
      end: text(row.get(props.end)),
      allDay: row.get(props['all-day']) === true,
    },
  };
}

function baselineOf(row: PluginResource, props: Props): Projection | null {
  const raw = row.get(props['sync-baseline']);
  if (typeof raw !== 'string' || !raw) return null;

  try {
    return JSON.parse(raw) as Projection;
  } catch {
    return null;
  }
}

/** Mirrors adapter.ts `validate()`, returning the reason instead of throwing. */
export function invalid(value: Projection): string | undefined {
  if (!value.title.trim()) return 'the title is empty';
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const dateTime = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
  const ok = (v: string) =>
    value.allDay
      ? date.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
      : dateTime.test(v) && Number.isFinite(Date.parse(v));
  if (!ok(value.start) || !ok(value.end))
    return value.allDay
      ? 'all-day Start and End must be YYYY-MM-DD'
      : 'Start and End need a date-time with a UTC offset';
  const at = (v: string) =>
    value.allDay ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  if (at(value.end) <= at(value.start)) return 'End must be after Start';

  return undefined;
}

export interface Rows {
  props: Props;
  bound: Map<string, PluginResource>;
  /** Rows with no Google event id: made in the table, never sent. */
  localOnly: number;
  /** Bound rows whose local value can't be sent, with the reason. */
  invalid: Map<string, { title: string; reason: string }>;
}

async function readRows(
  store: PluginStore,
  where: Layout,
  props: Props,
): Promise<Rows> {
  const out: Rows = {
    props,
    bound: new Map(),
    localOnly: 0,
    invalid: new Map(),
  };

  for (const subject of await store.query({
    property: PARENT,
    value: where.table,
  })) {
    const row = await store.getResource(subject);
    const card = cardOf(row, props);
    if (!card.id) out.localOnly++;
    else out.bound.set(subject, row);
  }

  return out;
}

/** The adapter's `Host` over the app's rows and the host's proxy calls. */
function host(
  proxy: HostProxy,
  connectionId: string,
  rows: Rows,
): Host & { rows: Rows } {
  const relayed = relay(proxy, connectionId);
  const { props } = rows;

  return {
    rows,
    read: intent => relayed.read(intent),
    async cards() {
      const cards: Card[] = [];

      for (const row of rows.bound.values()) {
        const card = cardOf(row, props);
        const reason = invalid(card.value);

        if (reason) {
          // Held back, not dropped: the baseline stands in for it, so the
          // row keeps its binding and nothing on either side changes.
          rows.invalid.set(row.subject, { title: card.value.title, reason });
          const baseline = baselineOf(row, props);
          if (baseline) cards.push({ ...card, value: baseline });
          continue;
        }

        cards.push(card);
      }

      return cards;
    },
    async state() {
      const records: Record<
        string,
        { local: string; baseline: Record<string, unknown> | null }
      > = {};

      for (const row of rows.bound.values()) {
        const id = row.get(props['google-event-id']) as string;
        records[id] = { local: row.subject, baseline: baselineOf(row, props) };
      }

      return { revision: 0, records, cursor: null };
    },
  };
}

export interface PendingEdit {
  edit: Edit;
  /** The ETag the preview read; the write is conditioned on it. */
  etag: string;
  title: string;
  /** Per changed field: what Google has now, and what would be sent. */
  fields: Array<{ field: string; before: string; after: string }>;
}

export interface ImportSummary {
  calendarId: string;
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: Preview['skipped'];
  conflicts: Array<{ title: string; fields: string[] }>;
  localOnly: number;
  invalid: Array<{ title: string; reason: string }>;
  review: PendingEdit[];
}

const LABELS: Record<keyof Projection, string> = {
  title: 'Title',
  description: 'Description',
  location: 'Location',
  start: 'Start',
  end: 'End',
  allDay: 'All day',
};

function fieldsOf(before: Projection, after: Projection) {
  return (Object.keys(LABELS) as Array<keyof Projection>)
    .filter(k => before[k] !== after[k])
    .map(k => ({
      field: LABELS[k],
      before: String(before[k]),
      after: String(after[k]),
    }));
}

function valuesOf(props: Props, value: Projection): Record<string, JSONValue> {
  return {
    [NAME]: value.title,
    [DESCRIPTION]: value.description,
    [props.location]: value.location,
    [props.start]: value.start,
    [props.end]: value.end,
    [props['all-day']]: value.allDay,
    [props.day]: value.start.slice(0, 10),
  };
}

function writeRow(
  row: PluginResource,
  props: Props,
  value: Projection,
): boolean {
  let changed = false;

  for (const [property, v] of Object.entries(valuesOf(props, value)))
    if (row.get(property) !== v) {
      row.set(property, v);
      changed = true;
    }

  return changed;
}

/**
 * Reads the whole calendar, reconciles it with the rows and applies the
 * inbound half: new events become rows, Google-side edits update rows that
 * were not edited here. Local edits are not sent; they come back as
 * `review`, to be approved and sent with `send()`. Conflicts leave both
 * sides as they are.
 */
export async function refresh(
  store: PluginStore,
  proxy: HostProxy,
  connectionId: string,
  options: { maxPages?: number } = {},
): Promise<ImportSummary> {
  const where = await layout(store);
  const props = await properties(store, where, true);
  const table = await store.getResource(where.table);
  const calendarId = table.get(props!['google-calendar-id']);
  if (typeof calendarId !== 'string' || !calendarId)
    throw new Error('Choose a calendar first.');
  const rows = await readRows(store, where, props!);
  const h = host(proxy, connectionId, rows);
  const result = await preview(h, calendarId, options);
  const titles = new Map(
    [...rows.bound.values()].map(r => [r.subject, text(r.get(NAME))]),
  );
  const summary: ImportSummary = {
    calendarId,
    total: result.changes.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: result.skipped,
    conflicts: result.conflicts.map(c => ({
      title: (c.subject && titles.get(c.subject)) || c.id || '(untitled)',
      fields: c.fields,
    })),
    localOnly: rows.localOnly,
    invalid: [...rows.invalid.values()],
    review: [],
  };

  for (const change of result.changes) {
    if (!change.id || !change.remote) continue;
    if (change.subject && rows.invalid.has(change.subject)) continue;
    const baseline = JSON.stringify(change.remote);

    if (!change.subject) {
      await store.newResource({
        parent: where.table,
        isA: [where.rowClass],
        propVals: {
          ...valuesOf(props!, change.desired),
          [props!['google-event-id']]: change.id,
          [props!['google-etag']]: change.etag ?? '',
          [props!['sync-baseline']]: baseline,
        },
      });
      summary.added++;
      continue;
    }

    const row = rows.bound.get(change.subject)!;
    const updated = writeRow(row, props!, change.desired);
    const bookkeeping =
      row.get(props!['google-etag']) !== (change.etag ?? '') ||
      row.get(props!['sync-baseline']) !== baseline;
    if (bookkeeping)
      row
        .set(props!['google-etag'], change.etag ?? '')
        .set(props!['sync-baseline'], baseline);
    if (updated || bookkeeping) await row.save();
    if (updated) summary.updated++;
    else summary.unchanged++;

    const edit = planEdit(
      change.id,
      change.desired,
      change.remote,
      change.subject,
    );
    if (edit && change.etag)
      summary.review.push({
        edit,
        etag: change.etag,
        title: change.remote.title,
        fields: fieldsOf(change.remote, change.desired),
      });
  }

  return summary;
}

export type Outcome =
  | { status: 'sent'; title: string }
  /** Google answered 412: the event changed after the preview. */
  | { status: 'stale'; title: string }
  /** The call threw: Google may or may not have the change. */
  | { status: 'uncertain'; title: string; message: string }
  | { status: 'failed'; title: string; message: string }
  /** Not attempted, because an earlier write's outcome was unknown. */
  | { status: 'not-sent'; title: string };

/**
 * Sends reviewed edits one by one, each a PATCH of only the changed fields,
 * with `If-Match` set to the ETag its preview read. A 412 or a refusal
 * affects only that event. An uncertain outcome (the call threw, so it may
 * have reached Google) stops the batch; the next preview reads what Google
 * has. The baseline advances only for events Google confirmed.
 */
export async function send(
  store: PluginStore,
  proxy: HostProxy,
  connectionId: string,
  calendarId: string,
  review: PendingEdit[],
): Promise<Outcome[]> {
  const where = await layout(store);
  const props = (await properties(store, where, false))!;
  const h = relay(proxy, connectionId);
  const root = endpoint(calendarId);
  const outcomes: Outcome[] = [];
  let stop = false;

  for (const pending of review) {
    const { title } = pending;

    if (stop) {
      outcomes.push({ status: 'not-sent', title });
      continue;
    }

    try {
      const event = await applyEdit(
        { read: h.read, cards: async () => [], state: async () => never() },
        root,
        pending.edit,
        pending.etag,
      );
      const projection = project(event);

      if (pending.edit.subject && projection) {
        const row = await store.getResource(pending.edit.subject);
        await row
          .set(props['google-etag'], event.etag)
          .set(props['sync-baseline'], JSON.stringify(projection))
          .save();
      }

      outcomes.push({ status: 'sent', title });
    } catch (error) {
      if (error instanceof StaleEventError)
        outcomes.push({ status: 'stale', title });
      else if (error instanceof UncertainWriteError) {
        outcomes.push({ status: 'uncertain', title, message: error.message });
        stop = true;
      } else
        outcomes.push({
          status: 'failed',
          title,
          message: error instanceof Error ? error.message : String(error),
        });
    }
  }

  return outcomes;
}

function never(): never {
  throw new Error('applyEdit does not read connection state');
}
