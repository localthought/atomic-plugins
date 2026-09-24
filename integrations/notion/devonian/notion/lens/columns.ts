// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import { notionPlainText } from './projection.js';
import type { FetchedRecord, Term } from './types.js';

/**
 * One Atomic column (Property) for Notion rows: the schema half of the lens.
 * `shortname` is the stable key; `name` is what a person sees and may change
 * when the Notion property is renamed.
 */
export interface NotionColumn {
  shortname: string;
  name: string;
  datatype: Datatype;
  description: string;
}

/** Columns every Notion row gets, besides one per projected Notion property. */
export const NOTION_FIXED_COLUMNS: readonly NotionColumn[] = [
  {
    shortname: 'notion-page-id',
    name: 'Notion page id',
    datatype: Datatype.STRING,
    description: 'The Notion page this row was imported from. Row identity.',
  },
  {
    shortname: 'notion-data-source',
    name: 'Data source',
    datatype: Datatype.STRING,
    description: 'Title of the Notion data source (database) the page is in.',
  },
  {
    shortname: 'notion-url',
    name: 'Notion URL',
    datatype: Datatype.STRING,
    description: 'Link to the page in Notion.',
  },
  {
    shortname: 'notion-last-edited',
    name: 'Last edited in Notion',
    datatype: Datatype.TIMESTAMP,
    description: "The page's last_edited_time in Notion.",
  },
];

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The Notion property id of a projection term (`urn:atomic:notion:property:<id>`). */
export function notionPropertyId(term: Term): string {
  return decodeURIComponent(term.path.slice(term.path.lastIndexOf(':') + 1));
}

/**
 * Display names by stable Notion property id, from the pages' own
 * `properties` objects (keyed by name, each carrying its `id`). A property
 * renamed during one read keeps the last name seen.
 */
export function notionPropertyNames(
  records: readonly FetchedRecord[],
): Map<string, string> {
  const names = new Map<string, string>();

  for (const row of records)
    for (const [name, value] of Object.entries(object(row.values.properties)))
      if (typeof object(value).id === 'string')
        names.set(String(object(value).id), name);

  return names;
}

/**
 * Data-source titles by id, from syncables' `data-source` records: the plain
 * title, else the record name, else the id. A formatted title has no plain
 * form and falls back the same way.
 */
export function notionDataSourceTitles(
  records: readonly FetchedRecord[],
): Map<string, string> {
  const titles = new Map<string, string>();

  for (const source of records)
    if (source.resource === 'data-source')
      titles.set(
        source.id,
        notionPlainText(source.values.title) || source.name || source.id,
      );

  return titles;
}

/**
 * The fixed columns, then one per projected Notion property term, named after
 * the Notion property (or its id when no page carried a name for it).
 */
export function notionColumns(
  terms: readonly Term[],
  names: ReadonlyMap<string, string>,
): NotionColumn[] {
  return [
    ...NOTION_FIXED_COLUMNS,
    ...terms
      .filter(term => term.kind === 'property')
      .map(term => {
        const id = notionPropertyId(term);

        return {
          shortname: term.shortname,
          name: names.get(id) ?? id,
          datatype: term.datatype,
          description: term.description,
        };
      }),
  ];
}
