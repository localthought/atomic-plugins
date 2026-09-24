// @wc-ignore-file
/**
 * Reads the imported rows back from the app's data table, so the view can
 * show them without leaving the app (DESIGN.md §1, §7). One `query` for the
 * table's children, then `getMany` in batches of 100 (one round trip each).
 * A host without `getMany` gets one `getResource` per row, 16 at a time.
 */
import {
  MAX_GET_MANY,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';
import { atomic } from './sync.js';
import type { Schema } from './record.js';

export interface Row {
  subject: string;
  name: string;
  pageId?: string;
  /** The database title the sync stored ("Data source" column). */
  dataSource: string;
  url?: string;
  /** Notion's last_edited_time, ms since epoch. */
  lastEdited?: number;
  /** Every value by column shortname, fixed columns included. */
  values: Record<string, JSONValue>;
}

/** How many `getResource` calls run at once. */
export const ROW_READ_CONCURRENCY = 16;

export async function loadRows(
  store: PluginStore,
  schema: Schema,
): Promise<Row[]> {
  const subjects = await store.query({
    property: atomic.parent,
    value: schema.table,
  });
  const bySubject = new Map(
    [...schema.columns.values()].map(c => [c.subject, c.shortname]),
  );
  const rows: Row[] = [];

  const many = store.getMany?.bind(store);
  const size = many ? MAX_GET_MANY : ROW_READ_CONCURRENCY;

  for (let i = 0; i < subjects.length; i += size) {
    const slice = subjects.slice(i, i + size);
    const batch: (PluginResource | undefined)[] = many
      ? // An entry the host could not read (`{ subject, error }`) is skipped,
        // as a failed `getResource` is.
        (await many(slice)).map(entry =>
          entry.error === undefined ? (entry as PluginResource) : undefined,
        )
      : await Promise.all(
          slice.map(s => store.getResource(s).catch(() => undefined)),
        );

    for (const resource of batch) {
      if (!resource) continue;
      const values: Record<string, JSONValue> = {};

      for (const [property, value] of Object.entries(resource.props)) {
        const shortname = bySubject.get(property);
        if (shortname) values[shortname] = value;
      }

      const text = (key: string) =>
        typeof values[key] === 'string' ? (values[key] as string) : undefined;
      const edited = values['notion-last-edited'];
      const name = resource.get(atomic.name);
      // Only rows the sync made: they carry a Notion page id.
      const pageId = text('notion-page-id');
      if (!pageId) continue;

      rows.push({
        subject: resource.subject,
        name: typeof name === 'string' && name ? name : 'Untitled',
        pageId,
        dataSource: text('notion-data-source') ?? '',
        ...(text('notion-url') ? { url: text('notion-url') } : {}),
        ...(typeof edited === 'number'
          ? { lastEdited: edited }
          : typeof edited === 'string' && Number.isFinite(Date.parse(edited))
            ? { lastEdited: Date.parse(edited) }
            : {}),
        values,
      });
    }
  }

  return rows;
}
