// @wc-ignore-file
/**
 * The Notion row lens on Devonian's native Atomic Data API: one `AtomicLens`
 * per data source between the pages syncables read (after
 * `notionProjection`) and Atomic row resources, one property per column.
 * The lens store uses its own property URLs; `seed` and `toHost` translate
 * to and from the host's column Properties.
 *
 * `read` is what an import runs. `write` is the reverse mapping for the same
 * scalar subset, pure and tested, but nothing calls a connector that writes:
 * the connector here refuses create, update and delete. Write-back to Notion
 * needs a journalled bridge with conflict handling (ontola/atomic-plugins#8
 * item 2) and live evidence; it is not built.
 */
import { Datatype } from '@tomic/lib';
import {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
  type AtomicProjection,
  type AtomicResource,
  type AtomicValue,
} from './devonian-atomic.js';
import type { NotionColumn } from './columns.js';
import {
  isNotionFieldType,
  notionFieldShortname,
  notionFieldValue,
  notionPropertyValue,
  PAGE_RESOURCE,
} from './projection.js';
import type { FetchedRecord, JSONValue } from './types.js';

export const ATOMIC_NAME = 'https://atomicdata.dev/properties/name';

/**
 * Base for the lens store's own subjects and properties: a page's row is
 * `<base>/resources/<key>`, a column `<base>/properties/<shortname>`.
 * `.invalid` (RFC 2606) so they can never be mistaken for, or resolve to, a
 * real resource; they never leave the lens (see `toHost`).
 */
export const NOTION_LENS_BASE = 'https://notion-lens.invalid';

/** Identity scope of a data source's pages: Notion's own URL for it. */
export const notionDataSourceScope = (dataSource: string) =>
  `https://api.notion.com/v1/data_sources/${encodeURIComponent(dataSource)}`;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A page's raw Notion properties by stable property id. */
function rawProperties(page: FetchedRecord) {
  const byId = new Map<
    string,
    { name: string; type: string; raw: Record<string, unknown> }
  >();

  for (const [name, value] of Object.entries(object(page.values.properties))) {
    const raw = object(value);
    if (typeof raw.id === 'string' && typeof raw.type === 'string')
      byId.set(raw.id, { name, type: raw.type, raw });
  }

  return byId;
}

export interface NotionRowLensesOptions {
  /** Every column, fixed and projected (`notionColumns`). */
  columns: readonly NotionColumn[];
  /**
   * Column shortname -> the host's Property subject for it (any subject
   * string, e.g. atomic-server's `atomic:...`). A column without a binding
   * (e.g. an existing Property of another datatype) is not read or written.
   */
  bound: ReadonlyMap<string, string>;
}

/**
 * The lens's own property URL for a column. devonian requires HTTP(S) or DID
 * subjects and properties, and atomic-server's are `atomic:...`, so the lens
 * store is keyed by these and `fromHost`/`toHost` translate at the boundary.
 */
export const notionLensProperty = (shortname: string) =>
  `${NOTION_LENS_BASE}/properties/${encodeURIComponent(shortname)}`;

/**
 * The lenses of one import: a shared `AtomicStore` and identity map, and one
 * `AtomicLens` per data source (`lens()`), keyed by Notion page id. Rows in
 * the lens store have staging subjects; the host keeps its own row identity
 * (the page-id column) and moves values in and out with `seed`/`toHost`.
 */
export class NotionRowLenses {
  readonly store: AtomicStore;
  readonly identities: AtomicIdentityMap;
  /** Host Property subject by lens property, the name included. */
  private readonly host = new Map<string, string>([[ATOMIC_NAME, ATOMIC_NAME]]);

  constructor(private readonly options: NotionRowLensesOptions) {
    const schema = new AtomicSchema().property(ATOMIC_NAME, Datatype.STRING);

    for (const column of options.columns) {
      const subject = options.bound.get(column.shortname);
      if (!subject) continue;
      const property = notionLensProperty(column.shortname);
      schema.property(property, column.datatype);
      this.host.set(property, subject);
    }

    this.store = new AtomicStore(schema);
    this.identities = new AtomicIdentityMap(this.store, NOTION_LENS_BASE);
  }

  private property(shortname: string) {
    const property = notionLensProperty(shortname);

    return this.host.has(property) ? property : undefined;
  }

  /** The host Property a lens property is written to, if the lens owns one. */
  hostProperty(property: string): string | undefined {
    return this.host.get(property);
  }

  /** The host properties the lens owns on a row: the name and every bound column. */
  managed(): string[] {
    return [...new Set(this.host.values())];
  }

  /** The lens store subject of a Notion page. */
  subject(dataSource: string, pageId: string): string {
    return this.identities.subjectFor(
      { scope: notionDataSourceScope(dataSource), entity: PAGE_RESOURCE },
      pageId,
    );
  }

  /**
   * Loads an existing host row's managed values into the lens store before
   * a read, so the read's `unset` has something to remove and what it leaves
   * alone stays as it was. Unmanaged host properties are ignored.
   */
  seed(
    dataSource: string,
    pageId: string,
    hostValues: Readonly<Record<string, unknown>>,
  ): void {
    const set: Record<string, AtomicValue> = {};

    for (const [property, subject] of this.host)
      if (hostValues[subject] !== undefined && hostValues[subject] !== null)
        set[property] = hostValues[subject] as AtomicValue;
    this.store.patch(this.subject(dataSource, pageId), { set });
  }

  /** A lens row's managed values, keyed by host Property subject. */
  toHost(resource: AtomicResource): Record<string, JSONValue> {
    const values: Record<string, JSONValue> = {};

    for (const [property, subject] of this.host)
      if (resource[property] !== undefined)
        values[subject] = resource[property] as JSONValue;

    return values;
  }

  /**
   * The lens for one data source's pages, as projected by `notionProjection`
   * with `{ dataSource }`. `pages` backs the connector's `get`; `title` fills
   * the data-source column.
   */
  lens(
    dataSource: string,
    title: string,
    pages: readonly FetchedRecord[],
  ): AtomicLens<FetchedRecord> {
    const byId = new Map(pages.map(page => [page.id, page]));

    const refuse = async (): Promise<never> => {
      throw new Error(
        'The Notion lens is read-only here: write-back is not built (#8)',
      );
    };

    return new AtomicLens<FetchedRecord>({
      store: this.store,
      identities: this.identities,
      scope: notionDataSourceScope(dataSource),
      entity: PAGE_RESOURCE,
      connector: {
        id: page => page.id,
        get: async id => {
          const page = byId.get(String(id));
          if (!page) throw new Error(`Notion page ${id} was not in this read`);

          return page;
        },
        create: refuse,
        update: refuse,
        delete: refuse,
      },
      read: page => this.read(page, title),
      write: (resource, previous) => this.write(resource, previous),
    });
  }

  /**
   * Page -> row. Sets the name, the fixed columns and every projected value.
   * A Notion property that is empty (`null`, no option) is unset, so a value
   * cleared in Notion is cleared in Atomic. One with no lossless plain value
   * (formatted text) is neither set nor unset: the row keeps what it had.
   */
  read(page: FetchedRecord, title: string): AtomicProjection {
    const set: Record<string, AtomicValue> = { [ATOMIC_NAME]: page.name };
    const unset: string[] = [];

    const put = (shortname: string, value: JSONValue | undefined) => {
      const property = this.property(shortname);
      if (property && value !== undefined && value !== null)
        set[property] = value as AtomicValue;
    };

    put('notion-page-id', page.id);
    put('notion-data-source', title);
    put('notion-url', page.values.url);
    put('notion-last-edited', page.values['last-edited-time']);

    for (const [id, { type, raw }] of rawProperties(page)) {
      if (!isNotionFieldType(type)) continue;
      const shortname = notionFieldShortname(id);
      const property = this.property(shortname);
      if (!property) continue;
      const value = notionFieldValue(type, raw[type]);
      if (value === null) unset.push(property);
      else if (value !== undefined) put(shortname, page.values[shortname]);
    }

    return { set, unset };
  }

  /**
   * Row -> page: `previous` with each bound, supported Notion property
   * replaced by the row's value (absent -> Notion's empty). Every other
   * property and page field passes through, and so does a property whose
   * Notion value was never read (formatted text) while the row holds no value
   * for it; a row value for one throws. The title column, not the row name,
   * is what writes the Notion title.
   */
  write(resource: AtomicResource, previous: FetchedRecord | undefined) {
    if (!previous)
      throw new Error('Creating Notion pages from the lens is not supported');
    const properties: Record<string, unknown> = {
      ...object(previous.values.properties),
    };

    for (const [id, { name, type, raw }] of rawProperties(previous)) {
      if (!isNotionFieldType(type)) continue;
      const property = this.property(notionFieldShortname(id));
      if (!property) continue;
      const desired = resource[property] as JSONValue | undefined;

      // Formatted text, mentions or malformed options were never read into
      // the row; writing a plain value over them would lose them.
      if (notionFieldValue(type, raw[type]) === undefined) {
        if (desired === undefined) continue;
        throw new Error(
          `Notion property "${name}" has no lossless plain value; not overwriting it`,
        );
      }

      properties[name] = {
        ...raw,
        [type]: notionPropertyValue(type, desired),
      };
    }

    return {
      ...previous,
      values: {
        ...previous.values,
        properties: properties as Record<string, JSONValue>,
      },
    };
  }
}
