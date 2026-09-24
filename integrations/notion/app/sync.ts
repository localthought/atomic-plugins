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
import { IMPORT_LOCAL_ID, planRow } from './reconcile.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';
import { PLATFORM } from './transport.js';

/** A page's source identity in the host's import metadata (`localId`). */
export const sourceId = (pageId: string) => `notion-page:${pageId}`;

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

/** A row whose Atomic value was kept although Notion has another one. */
export interface RowConflict {
  subject: string;
  name: string;
  /** Column names, e.g. `Status`. */
  fields: string[];
}

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Rows with local edits that differ from Notion; the edits were kept. */
  conflicts: RowConflict[];
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
 * rows into the app's data table. Import only: nothing is written to Notion,
 * and a page that is gone from Notion (or archived) is left in place, never
 * deleted.
 *
 * Rows are matched by the host's import identity (`localId` =
 * `notion-page:<id>`, unique per table on the server), or, for rows imported
 * before it was written, by the page-id column. What a sync may change in an
 * existing row is `reconcile.ts`'s policy: local edits are kept, only fields
 * nobody edited follow Notion (a value cleared in Notion is removed), and a
 * field changed on both sides is reported in `conflicts`. A property the lens
 * cannot read losslessly (formatted text) is not managed for that page: it is
 * neither written nor removed.
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
  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    dataSources,
    warnings,
  };
  const own = new Set(
    await store.query({ property: atomic.parent, value: data.table }),
  );
  const columnName = new Map<string, string>([[atomic.name, 'Name']]);

  for (const column of columns) {
    const subject = bound.get(column.shortname);
    if (subject) columnName.set(subject, column.name);
  }

  const find = async (property: string, value: string) =>
    (await store.query({ property, value })).find(s => own.has(s));
  const host = (properties: Iterable<string>) =>
    [...properties]
      .map(p => lenses.hostProperty(p))
      .filter((p): p is string => !!p);

  for (const source of sources) {
    const lens = lenses.lens(source.dataSource, source.title, source.pages);

    for (const page of source.pages) {
      const id = sourceId(page.id);
      const subject =
        (await find(IMPORT_LOCAL_ID, id)) ?? (await find(pageId, page.id));
      const existing = subject ? await store.getResource(subject) : undefined;

      // The row's current values go into the lens store first, so the read's
      // `unset` has something to remove.
      if (existing) lenses.seed(source.dataSource, page.id, existing.props);

      const row = lenses.store.get(await lens.ingest(page));
      if (!row) throw new Error(`The lens produced no row for ${page.id}`);
      const hostValues = lenses.toHost(row);
      // What this read says about each column: a value, cleared, or nothing
      // (formatted text the lens cannot read, left alone).
      const projection = lenses.read(page, source.title);
      const readable = host(Object.keys(projection.set ?? {}));
      const managed = [...readable, ...host(projection.unset ?? [])];
      const plan = planRow({
        sourceId: id,
        source: Object.fromEntries(
          readable.map(p => [p, hostValues[p]]),
        ) as Record<string, JSONValue>,
        managed,
        row: existing?.props,
      });

      if (plan.op === 'create') {
        const created = await store.newResource({
          parent: data.table,
          isA: [data.rowClass],
          propVals: plan.set,
        });
        own.add(created.subject);
        result.created++;
        continue;
      }

      if (plan.conflicts.length)
        result.conflicts.push({
          subject: existing!.subject,
          name: String(existing!.get(atomic.name) ?? page.name),
          fields: plan.conflicts.map(
            c => columnName.get(c.property) ?? c.property,
          ),
        });

      if (plan.op === 'unchanged') {
        result.unchanged++;
        continue;
      }

      for (const property of plan.remove) existing!.remove(property);
      for (const [property, value] of Object.entries(plan.set))
        existing!.set(property, value);
      await existing!.save();
      if (plan.changesValues) result.updated++;
      else result.unchanged++;

      if (plan.remove.length) {
        // A host without removal for apps keeps the value; say so rather
        // than report a clear that did not happen. The next run retries.
        const after = await store.getResource(existing!.subject);
        const kept = plan.remove.filter(p => after.get(p) !== undefined);
        if (kept.length)
          warnings.push(
            `Could not clear ${kept.map(p => columnName.get(p) ?? p).join(', ')} of "${page.name}": this host does not remove values for apps yet`,
          );
      }
    }
  }

  return result;
}
