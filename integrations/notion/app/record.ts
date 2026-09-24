// @wc-ignore-file
/**
 * What the app remembers between opens, stored in the drive rather than in
 * the frame (a null-origin frame has no usable localStorage):
 *
 * - the app's columns: the Properties the sync created under the row class's
 *   ontology, found again by shortname;
 * - the last sync record: counts, duration, and per data source its schema
 *   (property order, types, option names and colours) and its warnings. One
 *   JSON string property, `notion-sync-record`, on the data table resource
 *   (DESIGN.md §12's proposal). Its Property lives in the same ontology as
 *   the columns, but is not in the row class's `recommends`, so it never
 *   becomes a column.
 */
import { atomic, type DataSourceReport, type SyncResult } from './sync.js';
import type { PluginResource, PluginStore } from './store.js';

export const RECORD_SHORTNAME = 'notion-sync-record';
const STRING = 'https://atomicdata.dev/datatypes/string';

export interface SyncRecord {
  version: 1;
  /** When the sync finished (ms since epoch). */
  at: number;
  durationMs: number;
  created: number;
  updated: number;
  unchanged: number;
  dataSources: DataSourceReport[];
  /**
   * Warnings not tied to one data source: an incomplete read, a column that
   * exists with another datatype.
   */
  general: string[];
}

export interface Column {
  subject: string;
  shortname: string;
  name: string;
  datatype: string;
}

export interface Schema {
  table: string;
  rowClass: string;
  ontology: string;
  /** By shortname. */
  columns: Map<string, Column>;
}

const strings = (resource: PluginResource, property: string): string[] => {
  const raw = resource.get(property);

  return Array.isArray(raw) ? raw.map(String) : [];
};

/** The app's table, row class, ontology and the Properties in it. */
export async function loadSchema(
  store: PluginStore,
): Promise<Schema | undefined> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass) return undefined;
  const klass = await store.getResource(data.rowClass);
  const ontology = klass.get(atomic.parent);
  if (typeof ontology !== 'string') return undefined;
  const subjects = strings(await store.getResource(ontology), atomic.properties);
  const columns = new Map<string, Column>();

  for (const property of await Promise.all(
    subjects.map(s => store.getResource(s).catch(() => undefined)),
  )) {
    const shortname = property?.get(atomic.shortname);
    if (!property || typeof shortname !== 'string') continue;
    columns.set(shortname, {
      subject: property.subject,
      shortname,
      name: String(property.get(atomic.name) ?? shortname),
      datatype: String(property.get(atomic.datatype) ?? ''),
    });
  }

  return { table: data.table, rowClass: data.rowClass, ontology, columns };
}

const isLensNote = (warning: string) => warning.startsWith('Notion page ');

export function toRecord(
  result: SyncResult,
  startedAt: number,
  finishedAt: number,
): SyncRecord {
  return {
    version: 1,
    at: finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    dataSources: result.perDataSource,
    general: result.warnings.filter(w => !isLensNote(w)),
  };
}

/** A stored record, or `undefined` when absent or not one this app wrote. */
export function parseRecord(value: unknown): SyncRecord | undefined {
  if (typeof value !== 'string') return undefined;

  try {
    const parsed = JSON.parse(value) as Partial<SyncRecord>;

    return parsed &&
      parsed.version === 1 &&
      typeof parsed.at === 'number' &&
      Array.isArray(parsed.dataSources)
      ? {
          durationMs: 0,
          created: 0,
          updated: 0,
          unchanged: 0,
          general: [],
          ...parsed,
        } as SyncRecord
      : undefined;
  } catch {
    return undefined;
  }
}

export async function loadRecord(
  store: PluginStore,
  schema: Schema,
): Promise<SyncRecord | undefined> {
  const column = schema.columns.get(RECORD_SHORTNAME);
  if (!column) return undefined;

  return parseRecord((await store.getResource(schema.table)).get(column.subject));
}

/**
 * Writes the record onto the table resource, creating its Property the first
 * time. Returns the schema, updated when the Property was created.
 */
export async function saveRecord(
  store: PluginStore,
  schema: Schema,
  record: SyncRecord,
): Promise<Schema> {
  let column = schema.columns.get(RECORD_SHORTNAME);

  if (!column) {
    const created = await store.newResource({
      parent: schema.ontology,
      isA: [atomic.propertyClass],
      propVals: {
        [atomic.shortname]: RECORD_SHORTNAME,
        [atomic.name]: 'Notion sync record',
        [atomic.datatype]: STRING,
        [atomic.description]:
          'Written by the Notion app after each sync: when it ran, counts, and each database’s properties and warnings, as JSON.',
      },
    });
    const ontology = await store.getResource(schema.ontology);
    ontology.set(atomic.properties, [
      ...strings(ontology, atomic.properties),
      created.subject,
    ]);
    await ontology.save();
    column = {
      subject: created.subject,
      shortname: RECORD_SHORTNAME,
      name: 'Notion sync record',
      datatype: STRING,
    };
    schema = {
      ...schema,
      columns: new Map([...schema.columns, [RECORD_SHORTNAME, column]]),
    };
  }

  const table = await store.getResource(schema.table);
  table.set(column.subject, JSON.stringify(record));
  await table.save();

  return schema;
}
