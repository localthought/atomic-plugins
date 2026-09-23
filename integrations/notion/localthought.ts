// @wc-ignore-file
/**
 * Notion as a LocalThought extension: the read-only first slice of moving
 * Notion onto the reflector/syncables/Devonian stack
 * (ontola/atomic-plugins#8). The integration proxy owns the OAuth token and the
 * `Notion-Version` header. A host that composes `BrowserIntegrations` with a
 * sync engine pages through one data source's pages with
 * `notionDataSourceQuery`. The platform lens (in
 * devonian/notion/) then turns the fetched pages into typed
 * rows keyed by stable Notion property ids.
 *
 * Not here yet: the CRUD Causality and pagination overlay that would let
 * syncables discover and page Notion without this helper, write-back through a
 * Devonian bridge, and view reconciliation. The sandbox `plugin.ts` still owns
 * two-way sync until those exist.
 */
import { uuid } from './model.js';

export {
  JSON_DATATYPE,
  NOTION_PLATFORM,
  PAGE_RESOURCE,
  notionFieldShortname,
  notionFieldTypes,
  notionFieldValue,
  notionPlainText,
  notionProjection,
  type FetchedPlatform,
  type FetchedRecord,
  type NotionFieldType,
  type NotionProjectionOptions,
  type Term,
} from './devonian/notion/index.js';

export const DATA_SOURCE_QUERY_PATH = '/v1/data_sources/{data_source_id}/query';
/** Notion's maximum `page_size` for data source queries. */
export const QUERY_PAGE_SIZE = 100;

export interface NotionQueryRequest {
  path: string;
  method: 'POST';
  body: string;
}

/**
 * One page of a data-source query, shaped for `BrowserIntegrations.request()`.
 * The path is relative to the proxy's `/proxy/notion` prefix. Query paging
 * uses a `start_cursor` in the POST body rather than the URL, so this has to be
 * built per request until an overlay declares that scheme.
 */
export function notionDataSourceQuery(
  dataSource: string,
  cursor?: string,
): NotionQueryRequest {
  if (cursor !== undefined && (!cursor || cursor.length > 1024))
    throw new Error('Invalid Notion query cursor');

  return {
    path: DATA_SOURCE_QUERY_PATH.replace('{data_source_id}', uuid(dataSource)),
    method: 'POST',
    body: JSON.stringify({
      page_size: QUERY_PAGE_SIZE,
      ...(cursor === undefined ? {} : { start_cursor: cursor }),
    }),
  };
}
