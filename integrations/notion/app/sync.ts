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
  NotionRowLenses,
  notionColumns,
  notionDataSourceTitles,
  notionProjection,
  notionPropertyNames,
  type FetchedPlatform,
  type FetchedRecord,
  type NotionColumn,
  type Term,
} from '../devonian/notion/index.js';
import type { PluginResource, PluginStore } from './store.js';
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
} as const;

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

/** One data source's pages, projected by the Notion lens. */
export interface NotionSource {
  dataSource: string;
  title: string;
  pages: FetchedRecord[];
}

/**
 * One read of every data source shared with the connection. Pages are
 * projected by the Notion lens one data source at a time (a page whose parent
 * is another data source fails the lens rather than landing in the wrong
 * place), and the lens derives the columns from what was read.
 */
export async function readNotion(
  transport: Transport,
  read: Read = readPlatform,
): Promise<{
  sources: NotionSource[];
  columns: NotionColumn[];
  dataSources: number;
  warnings: string[];
}> {
  const fetched = (await read(NOTION_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport,
  })) as unknown as FetchedPlatform;
  const titles = notionDataSourceTitles(fetched.records);
  const byDataSource = new Map<string, FetchedRecord[]>();

  for (const row of fetched.records)
    if (row.resource === 'page')
      byDataSource.set(row.namespace, [
        ...(byDataSource.get(row.namespace) ?? []),
        row,
      ]);

  const sources: NotionSource[] = [];
  const terms = new Map<string, Term>();
  const warnings = [...(fetched.errors ?? [])];

  for (const [dataSource, rows] of byDataSource) {
    const projected = notionProjection(
      { ...fetched, records: rows, errors: [] },
      { dataSource },
    );
    sources.push({
      dataSource,
      title: titles.get(dataSource) ?? dataSource,
      pages: projected.records,
    });
    warnings.push(...(projected.errors ?? []));
    for (const term of projected.ontology.terms)
      if (term.kind === 'property') terms.set(term.shortname, term);
  }

  return {
    sources,
    columns: notionColumns(
      [...terms.values()],
      notionPropertyNames(sources.flatMap(s => s.pages)),
    ),
    dataSources: titles.size,
    warnings,
  };
}

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
  columns: readonly NotionColumn[],
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
 * Read every shared data source's pages through the proxy, run them through
 * the Notion row lens (Devonian `AtomicLens.ingest`), and reconcile the lens's
 * rows into the app's data table by Notion page id. Import only: nothing is
 * written to Notion, and a page that is gone from Notion (or archived) is
 * left in place, never deleted. A value cleared in Notion is removed from its
 * row; one the lens cannot read losslessly is left as it was.
 */
export async function syncNotion(
  store: PluginStore,
  transport: Transport,
  read: Read = readPlatform,
): Promise<SyncResult> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no data table with a row class to fill');
  const { sources, columns, dataSources, warnings } = await readNotion(
    transport,
    read,
  );
  const bound = await ensureColumns(store, data.rowClass, columns, warnings);
  const pageId = bound.get('notion-page-id');
  if (!pageId) throw new Error('No column to key rows by Notion page id');

  const lenses = new NotionRowLenses({ columns, bound });
  const managed = lenses.managed();
  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    dataSources,
    warnings,
  };
  const own = new Set(
    await store.query({ property: atomic.parent, value: data.table }),
  );

  for (const source of sources) {
    const lens = lenses.lens(source.dataSource, source.title, source.pages);

    for (const page of source.pages) {
      const matches = await store.query({ property: pageId, value: page.id });
      const subject = matches.find(s => own.has(s));
      const existing = subject ? await store.getResource(subject) : undefined;

      // The row's current values go into the lens store first, so the read's
      // `unset` has something to remove.
      if (existing) lenses.seed(source.dataSource, page.id, existing.props);

      const row = lenses.store.get(await lens.ingest(page));
      if (!row) throw new Error(`The lens produced no row for ${page.id}`);
      const propVals = lenses.toHost(row);

      if (!existing) {
        const created = await store.newResource({
          parent: data.table,
          isA: [data.rowClass],
          propVals,
        });
        own.add(created.subject);
        result.created++;
        continue;
      }

      const changed = managed.filter(
        property =>
          JSON.stringify(existing.get(property)) !==
          JSON.stringify(propVals[property]),
      );

      if (!changed.length) {
        result.unchanged++;
        continue;
      }

      for (const property of changed)
        if (propVals[property] === undefined) existing.remove(property);
        else existing.set(property, propVals[property]);
      await existing.save();
      result.updated++;
    }
  }

  return result;
}
