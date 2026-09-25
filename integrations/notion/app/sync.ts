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
  isNotionFieldType,
  notionFieldShortname,
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
import { observedTransport, PLATFORM } from './transport.js';

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
  /**
   * The part of `warnings` that says the read itself was incomplete (a
   * collection failed), as opposed to lens notes about single pages.
   */
  readErrors: string[];
  /** The same counts and warnings per data source, plus its schema. */
  perDataSource: DataSourceReport[];
}

/** One option of a select, status or multi-select property. */
export interface NotionOption {
  id: string;
  name: string;
  /** One of Notion's ten colour names; anything else renders as `default`. */
  color: string;
}

/**
 * One property of a data source's schema, in Notion's order. `shortname` is
 * the column it lands in, only for the types the lens projects; the others
 * are listed so the view can say what was not copied.
 */
export interface SchemaProperty {
  id: string;
  name: string;
  type: string;
  shortname?: string;
  options?: NotionOption[];
}

export interface DataSourceReport {
  id: string;
  title: string;
  url?: string;
  /** Pages read (archived ones included). */
  pages: number;
  created: number;
  updated: number;
  unchanged: number;
  properties: SchemaProperty[];
  /** Pages whose formatted text in `property` was not imported. */
  formatted: { page: string; title: string; property: string }[];
  /** Archived or trashed pages: not imported, and an existing row is kept. */
  archived: string[];
  /** Any other lens message for this data source, verbatim. */
  errors: string[];
}

export type SyncPhase = 'listing' | 'reading' | 'writing' | 'done';

/**
 * Progress for one data source. Reported at most once per relayed request
 * (Notion returns up to 100 pages per query) and once per phase change,
 * never per row. `pages` is the number of pages read so far.
 */
export interface SyncProgress {
  dataSource: string;
  title: string;
  phase: SyncPhase;
  pages: number;
}

export interface SyncOptions {
  onProgress?: (progress: SyncProgress) => void;
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
  readErrors: string[];
  reports: DataSourceReport[];
}> {
  const fetched = (await read(NOTION_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport,
    sleep: pauseBriefly,
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
  const reports: DataSourceReport[] = [];
  const schemas = new Map(
    fetched.records
      .filter(r => r.resource === 'data-source')
      .map(r => [r.id, r] as const),
  );

  for (const dataSource of new Set([
    ...titles.keys(),
    ...byDataSource.keys(),
  ])) {
    const rows = byDataSource.get(dataSource) ?? [];
    const title = titles.get(dataSource) ?? dataSource;
    const projected = notionProjection(
      { ...fetched, records: rows, errors: [] },
      { dataSource },
    );
    const url = schemas.get(dataSource)?.values.url;
    const report: DataSourceReport = {
      id: dataSource,
      title,
      ...(typeof url === 'string' ? { url } : {}),
      pages: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      properties: schemaProperties(schemas.get(dataSource)),
      formatted: [],
      archived: [],
      errors: [],
    };
    const names = new Map(projected.records.map(r => [r.id, r.name]));

    for (const message of projected.errors ?? []) {
      const formatted =
        /^Notion page (\S+) property "(.*)" \([\w-]+\) has no lossless plain value/.exec(
          message,
        );
      const archived = /^Notion page (\S+) is archived or in trash/.exec(
        message,
      );
      if (formatted)
        report.formatted.push({
          page: formatted[1]!,
          title: names.get(formatted[1]!) ?? formatted[1]!,
          property: formatted[2]!,
        });
      else if (archived) report.archived.push(archived[1]!);
      else report.errors.push(message);
    }

    sources.push({ dataSource, title, pages: projected.records });
    reports.push(report);
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
    readErrors: [...(fetched.errors ?? [])],
    reports,
  };
}

/** Longest `retry-after` the sync waits out itself before giving up. */
export const MAX_INLINE_RETRY_MS = 10_000;

/**
 * syncables' wait before retrying a 429. A short one is waited out; a longer
 * one fails that collection instead, so the view can say "paused until" and
 * retry the whole (idempotent) sync then, rather than sit on "Syncing…".
 */
async function pauseBriefly(ms: number): Promise<void> {
  if (ms > MAX_INLINE_RETRY_MS)
    throw new Error(`Notion asked to wait ${Math.round(ms / 1000)} s`);
  await new Promise(resolve => setTimeout(resolve, ms));
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * A data source's properties in Notion's order (the `properties` object's
 * key order), with the options of select, status and multi-select
 * properties. Read from the data source record the search already returned,
 * so it costs no extra request.
 */
export function schemaProperties(
  source: FetchedRecord | undefined,
): SchemaProperty[] {
  const out: SchemaProperty[] = [];

  for (const [name, raw] of Object.entries(record(source?.values.properties))) {
    const property = record(raw);
    const { id, type } = property;
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    const options = record(property[type]).options;

    out.push({
      id,
      name: typeof property.name === 'string' ? property.name : name,
      type,
      ...(isNotionFieldType(type)
        ? { shortname: notionFieldShortname(id) }
        : {}),
      ...(Array.isArray(options)
        ? {
            options: options.flatMap(o => {
              const option = record(o);

              return typeof option.id === 'string'
                ? [
                    {
                      id: option.id,
                      name: typeof option.name === 'string' ? option.name : '',
                      color:
                        typeof option.color === 'string'
                          ? option.color
                          : 'default',
                    },
                  ]
                : [];
            }),
          }
        : {}),
    });
  }

  return out;
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
  { onProgress = () => {} }: SyncOptions = {},
): Promise<SyncResult> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no data table with a row class to fill');
  const { sources, columns, dataSources, warnings, readErrors, reports } =
    await readNotion(
      observedTransport(transport, progressTap(onProgress)),
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
    readErrors,
    perDataSource: reports,
  };
  const own = new Set(
    await store.query({ property: atomic.parent, value: data.table }),
  );

  for (const [index, source] of sources.entries()) {
    const report = reports[index]!;
    const lens = lenses.lens(source.dataSource, source.title, source.pages);
    onProgress({
      dataSource: source.dataSource,
      title: source.title,
      phase: 'writing',
      pages: report.pages,
    });

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
        report.created++;
        continue;
      }

      const changed = managed.filter(
        property =>
          JSON.stringify(existing.get(property)) !==
          JSON.stringify(propVals[property]),
      );

      if (!changed.length) {
        result.unchanged++;
        report.unchanged++;
        continue;
      }

      for (const property of changed)
        if (propVals[property] === undefined) existing.remove(property);
        else existing.set(property, propVals[property]);
      await existing.save();
      result.updated++;
      report.updated++;
    }

    onProgress({
      dataSource: source.dataSource,
      title: source.title,
      phase: 'done',
      pages: report.pages,
    });
  }

  return result;
}

const sameId = (a: string, b: string) =>
  a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();

/**
 * Turns relayed search and query responses into `listing` and `reading`
 * progress. syncables' `readPlatform` has no progress hook of its own, so
 * this reads the same responses it does: the search lists the data sources
 * (with titles), and each query page adds its `results` to one of them.
 */
function progressTap(onProgress: (progress: SyncProgress) => void) {
  const seen = new Map<string, SyncProgress>();

  return ({
    path,
    status,
    body,
  }: {
    path: string;
    status: number;
    body: unknown;
  }) => {
    if (status < 200 || status >= 300) return;
    const results = record(body).results;
    if (!Array.isArray(results)) return;

    if (/\/search(\?|$)/.test(path)) {
      for (const item of results.map(record))
        if (item.object === 'data_source' && typeof item.id === 'string') {
          if ([...seen.keys()].some(id => sameId(id, item.id as string)))
            continue;
          const progress: SyncProgress = {
            dataSource: item.id,
            title: notionPlainTitle(item.title) || item.id,
            phase: 'listing',
            pages: 0,
          };
          seen.set(item.id, progress);
          onProgress({ ...progress });
        }

      return;
    }

    const query = /\/data_sources\/([^/]+)\/query(\?|$)/.exec(path);
    if (!query) return;
    const id = decodeURIComponent(query[1]!);
    const key = [...seen.keys()].find(k => sameId(k, id)) ?? id;
    const progress = seen.get(key) ?? {
      dataSource: key,
      title: key,
      phase: 'reading' as const,
      pages: 0,
    };
    progress.phase = 'reading';
    progress.pages += results.length;
    seen.set(key, progress);
    onProgress({ ...progress });
  };
}

const notionPlainTitle = (title: unknown): string =>
  Array.isArray(title)
    ? title
        .map(part => record(part).plain_text)
        .filter((t): t is string => typeof t === 'string')
        .join('')
    : '';
