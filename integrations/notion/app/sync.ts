// @wc-ignore-file
import {
  readPlatform,
  type OpenApiDocument,
  type ReadOptions,
  type ReadResult,
  type Transport,
} from 'syncables/browser';
import document from '../catalog/notion.json' with { type: 'json' };
import {
  notionPlainText,
  notionProjection,
  type FetchedPlatform,
  type FetchedRecord,
  type Term,
} from '../devonian/notion/index.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';
import { PLATFORM } from './transport.js';

/** The composed catalog document (catalog/notion.json), bundled. */
export const NOTION_DOCUMENT = document as unknown as OpenApiDocument;

export const atomic = {
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  shortname: 'https://atomicdata.dev/properties/shortname',
  datatype: 'https://atomicdata.dev/properties/datatype',
  parent: 'https://atomicdata.dev/properties/parent',
  properties: 'https://atomicdata.dev/properties/properties',
  recommends: 'https://atomicdata.dev/properties/recommends',
  propertyClass: 'https://atomicdata.dev/classes/Property',
  string: 'https://atomicdata.dev/datatypes/string',
  timestamp: 'https://atomicdata.dev/datatypes/timestamp',
} as const;

/** Columns every row gets, besides the lens's one per Notion property. */
const FIXED = [
  {
    shortname: 'notion-page-id',
    name: 'Notion page id',
    datatype: atomic.string,
    description: 'The Notion page this row was imported from. Row identity.',
  },
  {
    shortname: 'notion-data-source',
    name: 'Data source',
    datatype: atomic.string,
    description: 'Title of the Notion data source (database) the page is in.',
  },
  {
    shortname: 'notion-url',
    name: 'Notion URL',
    datatype: atomic.string,
    description: 'Link to the page in Notion.',
  },
  {
    shortname: 'notion-last-edited',
    name: 'Last edited in Notion',
    datatype: atomic.timestamp,
    description: "The page's last_edited_time in Notion.",
  },
] as const;

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  dataSources: number;
  /** Non-fatal: unprojected formatted text, archived pages, a partial read. */
  warnings: string[];
}

type Read = (
  document: OpenApiDocument,
  options: ReadOptions,
) => Promise<ReadResult>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * One read of every data source shared with the connection, projected by the
 * read-only Notion lens per data source (a page whose parent is another data
 * source fails the lens rather than landing in the wrong place).
 */
export async function readNotion(
  transport: Transport,
  read: Read = readPlatform,
): Promise<{
  projected: FetchedPlatform;
  titles: Map<string, string>;
  names: Map<string, string>;
}> {
  const fetched = await read(NOTION_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport,
  });
  const titles = new Map<string, string>();

  for (const source of fetched.records.filter(
    r => r.resource === 'data-source',
  ))
    titles.set(
      source.id,
      notionPlainText(source.values.title) || source.name || source.id,
    );

  const byNamespace = new Map<string, FetchedRecord[]>();

  for (const row of fetched.records as unknown as FetchedRecord[])
    if (row.resource === 'page')
      byNamespace.set(row.namespace, [
        ...(byNamespace.get(row.namespace) ?? []),
        row,
      ]);

  const records: FetchedRecord[] = [];
  const terms = new Map<string, Term>();
  const warnings = [...fetched.errors];

  for (const [dataSource, rows] of byNamespace) {
    const projected = notionProjection(
      { ...(fetched as unknown as FetchedPlatform), records: rows, errors: [] },
      { dataSource },
    );
    records.push(...projected.records);
    warnings.push(...(projected.errors ?? []));
    for (const term of projected.ontology.terms)
      if (term.kind === 'property') terms.set(term.shortname, term);
  }

  // Display names by stable property id, from the pages' own `properties`.
  const names = new Map<string, string>();

  for (const row of records)
    for (const [name, value] of Object.entries(record(row.values.properties)))
      if (typeof record(value).id === 'string')
        names.set(String(record(value).id), name);

  return {
    projected: {
      platform: PLATFORM,
      ontology: { description: '', terms: [...terms.values()] },
      records,
      errors: warnings,
    },
    titles,
    names,
  };
}

/** The lens term's Notion property id, from its `urn:...:property:<id>` path. */
const propertyId = (term: Term) =>
  decodeURIComponent(term.path.slice(term.path.lastIndexOf(':') + 1));

const values = (resource: PluginResource, property: string): string[] => {
  const raw = resource.get(property);

  return Array.isArray(raw) ? raw.map(String) : [];
};

/**
 * Finds or creates one Property per column under the row class's ontology
 * (the app's own subtree, where the host lets an app write), and lists it in
 * the ontology's `properties` and the class's `recommends`. An existing
 * property with another datatype is left alone and its column skipped.
 */
async function ensureColumns(
  store: PluginStore,
  rowClass: string,
  columns: {
    shortname: string;
    name: string;
    datatype: string;
    description: string;
  }[],
  warnings: string[],
): Promise<Map<string, string>> {
  const klass = await store.getResource(rowClass);
  const ontologySubject = klass.get(atomic.parent);
  if (typeof ontologySubject !== 'string')
    throw new Error('The row class has no parent ontology to add columns to');
  const ontology = await store.getResource(ontologySubject);
  const existing = new Map<string, PluginResource>();

  for (const subject of values(ontology, atomic.properties)) {
    const property = await store.getResource(subject);
    const shortname = property.get(atomic.shortname);
    if (typeof shortname === 'string') existing.set(shortname, property);
  }

  const bound = new Map<string, string>();
  const added: string[] = [];

  for (const column of columns) {
    const found = existing.get(column.shortname);

    if (found) {
      if (found.get(atomic.datatype) !== column.datatype) {
        warnings.push(
          `Column "${column.name}" exists with another datatype; not imported`,
        );
        continue;
      }

      bound.set(column.shortname, found.subject);
      continue;
    }

    const created = await store.newResource({
      parent: ontologySubject,
      isA: [atomic.propertyClass],
      propVals: {
        [atomic.shortname]: column.shortname,
        [atomic.name]: column.name,
        [atomic.datatype]: column.datatype,
        [atomic.description]: column.description,
      },
    });
    bound.set(column.shortname, created.subject);
    added.push(created.subject);
  }

  if (added.length) {
    ontology.set(atomic.properties, [
      ...values(ontology, atomic.properties),
      ...added,
    ]);
    await ontology.save();
  }

  const recommends = values(klass, atomic.recommends);
  const missing = [...bound.values()].filter(s => !recommends.includes(s));

  if (missing.length) {
    klass.set(atomic.recommends, [...recommends, ...missing]);
    await klass.save();
  }

  return bound;
}

/**
 * Read every shared data source's pages through the proxy, project them with
 * the Notion lens, and reconcile them into the app's data table by Notion
 * page id. Import only: nothing is written to Notion, and a page that is gone
 * from Notion (or archived) is left in place, never deleted.
 */
export async function syncNotion(
  store: PluginStore,
  transport: Transport,
  read: Read = readPlatform,
): Promise<SyncResult> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no data table with a row class to fill');
  const { projected, titles, names } = await readNotion(transport, read);
  const warnings = [...(projected.errors ?? [])];

  const lensColumns = projected.ontology.terms.map(term => {
    const id = propertyId(term);
    const name = names.get(id) ?? id;

    return {
      shortname: term.shortname,
      name,
      datatype: String(term.datatype),
      description: term.description,
    };
  });
  const columns = await ensureColumns(
    store,
    data.rowClass,
    [...FIXED, ...lensColumns],
    warnings,
  );
  const pageId = columns.get('notion-page-id');
  if (!pageId) throw new Error('No column to key rows by Notion page id');

  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    dataSources: titles.size,
    warnings,
  };
  const own = new Set(
    await store.query({ property: atomic.parent, value: data.table }),
  );

  for (const page of projected.records) {
    const row: Record<string, JSONValue> = { [atomic.name]: page.name };

    const set = (shortname: string, value: JSONValue) => {
      const property = columns.get(shortname);
      if (property && value !== undefined && value !== null)
        row[property] = value;
    };

    set('notion-page-id', page.id);
    set('notion-data-source', titles.get(page.namespace) ?? page.namespace);
    set('notion-url', page.values.url as JSONValue);
    set('notion-last-edited', page.values['last-edited-time'] as JSONValue);
    for (const { shortname } of lensColumns)
      set(shortname, page.values[shortname] as JSONValue);

    const matches = await store.query({ property: pageId, value: page.id });
    const subject = matches.find(s => own.has(s));

    if (!subject) {
      const created = await store.newResource({
        parent: data.table,
        isA: [data.rowClass],
        propVals: row,
      });
      own.add(created.subject);
      result.created++;
      continue;
    }

    const existing = await store.getResource(subject);
    const changed = Object.entries(row).filter(
      ([property, value]) =>
        JSON.stringify(existing.get(property)) !== JSON.stringify(value),
    );

    if (!changed.length) {
      result.unchanged++;
      continue;
    }

    for (const [property, value] of changed) existing.set(property, value);
    await existing.save();
    result.updated++;
  }

  return result;
}
