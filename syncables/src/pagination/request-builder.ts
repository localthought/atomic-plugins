import type { PaginationSchemeObject, PaginationQuery } from './types.js';
import type { PaginationResponseState } from './types.js';

/** Where the client is in a paginated traversal, independent of scheme type. */
export interface PageCursor {
  offset?: number;
  page?: number;
  pageToken?: string;
}

function fieldsWithRole(
  scheme: PaginationSchemeObject,
  role: string,
): string[] {
  return Object.entries(scheme.request?.queryParameters ?? {})
    .filter(([, field]) => field.role === role)
    .map(([name]) => name);
}

/** Builds the query parameters for one page request from the current cursor. */
export function buildQuery(
  scheme: PaginationSchemeObject,
  cursor: PageCursor,
  pageSize?: number,
): PaginationQuery {
  const query: PaginationQuery = {};

  if (pageSize !== undefined) {
    for (const name of fieldsWithRole(scheme, 'pageSize')) {
      query[name] = String(pageSize);
    }
  }
  for (const name of fieldsWithRole(scheme, 'offset')) {
    query[name] = String(cursor.offset ?? 0);
  }
  for (const name of fieldsWithRole(scheme, 'page')) {
    query[name] = String(cursor.page ?? 1);
  }
  if (cursor.pageToken !== undefined) {
    for (const name of [
      ...fieldsWithRole(scheme, 'pageToken'),
      ...fieldsWithRole(scheme, 'cursor'),
    ]) {
      query[name] = cursor.pageToken;
    }
  }

  return query;
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

  switch (scheme.type) {
    case 'pageToken':
      return state.nextPageToken !== null
        ? { pageToken: state.nextPageToken }
        : null;
    case 'nextLink':
      return null;
    case 'pageNumber':
      if (fieldsWithRole(scheme, 'offset').length > 0) {
        return { offset: (cursor.offset ?? 0) + itemsReturned };
      }
      if (fieldsWithRole(scheme, 'page').length > 0) {
        return { page: (cursor.page ?? 1) + 1 };
      }
      return null;
  }
}
