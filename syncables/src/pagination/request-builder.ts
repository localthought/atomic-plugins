import type {
  PaginationQuery,
  PaginationSchemeObject,
  RequestFieldObject,
} from './types.js';
import type { PaginationResponseState } from './types.js';
import { setNestedField } from './response-parser.js';

/** Where the client is in a paginated traversal, independent of scheme type. */
export interface PageCursor {
  offset?: number;
  page?: number;
  pageToken?: string;
}

type RequestLocation = 'queryParameters' | 'bodyFields';

function fieldsWithRole(
  scheme: PaginationSchemeObject,
  role: string,
  locations: RequestLocation[] = ['queryParameters'],
): string[] {
  return locations.flatMap((location) =>
    Object.entries(
      (scheme.request?.[location] ?? {}) as Record<string, RequestFieldObject>,
    )
      .filter(([, field]) => field.role === role)
      .map(([name]) => name),
  );
}

/**
 * The values a page request carries, by field name, for one location
 * (query parameters or JSON body fields). Numbers stay numbers here; the
 * query builder stringifies them.
 */
function cursorValues(
  scheme: PaginationSchemeObject,
  cursor: PageCursor,
  pageSize: number | undefined,
  location: RequestLocation,
): Record<string, number | string> {
  const values: Record<string, number | string> = {};
  const withRole = (role: string): string[] =>
    fieldsWithRole(scheme, role, [location]);

  if (pageSize !== undefined) {
    for (const name of withRole('pageSize')) {
      values[name] = pageSize;
    }
  }
  for (const name of withRole('offset')) {
    values[name] = cursor.offset ?? 0;
  }
  for (const name of withRole('page')) {
    values[name] = cursor.page ?? 1;
  }
  if (cursor.pageToken !== undefined) {
    for (const name of [...withRole('pageToken'), ...withRole('cursor')]) {
      values[name] = cursor.pageToken;
    }
  }

  return values;
}

/** Builds the query parameters for one page request from the current cursor. */
export function buildQuery(
  scheme: PaginationSchemeObject,
  cursor: PageCursor,
  pageSize?: number,
): PaginationQuery {
  const query: PaginationQuery = {};
  for (const [name, value] of Object.entries(
    cursorValues(scheme, cursor, pageSize, 'queryParameters'),
  )) {
    query[name] = String(value);
  }
  return query;
}

/**
 * Builds the JSON request-body fields for one page request from the
 * current cursor, for schemes that paginate through `request.bodyFields`
 * (e.g. Notion's `POST /v1/search`, which takes `start_cursor` and
 * `page_size` in the body). Field names may be dotted paths into nested
 * objects. Page sizes, offsets and page numbers are JSON numbers; tokens
 * are strings. A token field is omitted until a token exists, so the first
 * request carries no cursor at all. Returns `{}` for a query-only scheme.
 */
export function buildBody(
  scheme: PaginationSchemeObject,
  cursor: PageCursor,
  pageSize?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(
    cursorValues(scheme, cursor, pageSize, 'bodyFields'),
  )) {
    setNestedField(body, name, value);
  }
  return body;
}

/** Whether a scheme sends any of its cursor in the request body. */
export function usesRequestBody(scheme: PaginationSchemeObject): boolean {
  return Object.keys(scheme.request?.bodyFields ?? {}).length > 0;
}

/**
 * Computes the cursor for the next page from the previous cursor and the
 * parsed response state. Returns null when there is no next page, or when
 * the scheme type is `nextLink` — for that type the caller should follow
 * `state.nextLink` directly rather than rebuilding query parameters.
 */
export function nextCursor(
  scheme: PaginationSchemeObject,
  cursor: PageCursor,
  state: PaginationResponseState,
  itemsReturned: number,
): PageCursor | null {
  if (!state.hasNextPage) {
    return null;
  }

  const both: RequestLocation[] = ['queryParameters', 'bodyFields'];
  switch (scheme.type) {
    case 'pageToken':
      return state.nextPageToken !== null
        ? { pageToken: state.nextPageToken }
        : null;
    case 'nextLink':
      return null;
    case 'pageNumber':
      if (fieldsWithRole(scheme, 'offset', both).length > 0) {
        return { offset: (cursor.offset ?? 0) + itemsReturned };
      }
      if (fieldsWithRole(scheme, 'page', both).length > 0) {
        return { page: (cursor.page ?? 1) + 1 };
      }
      return null;
  }
}
