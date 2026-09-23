import { describe, expect, it } from 'vitest';
import { buildBody, buildQuery, nextCursor } from '../../../src/pagination/request-builder.js';
import type { PaginationSchemeObject, PaginationResponseState } from '../../../src/pagination/types.js';

function state(overrides: Partial<PaginationResponseState> = {}): PaginationResponseState {
  return {
    nextPageToken: null,
    nextLink: null,
    currentPage: null,
    totalCount: null,
    totalPages: null,
    pageSize: null,
    hasNextPage: true,
    ...overrides,
  };
}

describe('buildQuery', () => {
  it('builds offset + pageSize query parameters', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      request: { queryParameters: { offset: { role: 'offset' }, limit: { role: 'pageSize' } } },
    };
    expect(buildQuery(scheme, { offset: 6 }, 3)).toEqual({ offset: '6', limit: '3' });
  });

  it('builds page-number query parameters, defaulting to page 1', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      request: { queryParameters: { page: { role: 'page' } } },
    };
    expect(buildQuery(scheme, {})).toEqual({ page: '1' });
  });

  it('builds a pageToken query parameter only once a token exists', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageToken',
      request: { queryParameters: { cursor: { role: 'pageToken' } } },
    };
    expect(buildQuery(scheme, {})).toEqual({});
    expect(buildQuery(scheme, { pageToken: 'abc' })).toEqual({ cursor: 'abc' });
  });
});

describe('buildBody', () => {
  const notion: PaginationSchemeObject = {
    type: 'pageToken',
    request: {
      bodyFields: { start_cursor: { role: 'cursor' }, page_size: { role: 'pageSize' } },
    },
  };

  it('puts a body-field cursor in the body, not the query', () => {
    expect(buildQuery(notion, { pageToken: 'abc' }, 50)).toEqual({});
    expect(buildBody(notion, {}, 50)).toEqual({ page_size: 50 });
    expect(buildBody(notion, { pageToken: 'abc' }, 50)).toEqual({ page_size: 50, start_cursor: 'abc' });
  });

  it('writes dotted body fields as nested objects, numbers as numbers', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      request: { bodyFields: { 'paging.offset': { role: 'offset' } } },
    };
    expect(buildBody(scheme, { offset: 20 })).toEqual({ paging: { offset: 20 } });
  });

  it('advances a body-field offset like a query-parameter one', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      request: { bodyFields: { offset: { role: 'offset' } } },
    };
    expect(nextCursor(scheme, { offset: 3 }, state(), 3)).toEqual({ offset: 6 });
  });

  it('returns an empty body for a query-only scheme', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      request: { queryParameters: { page: { role: 'page' } } },
    };
    expect(buildBody(scheme, { page: 2 })).toEqual({});
  });
});

describe('nextCursor', () => {
  const offsetScheme: PaginationSchemeObject = {
    type: 'pageNumber',
    request: { queryParameters: { offset: { role: 'offset' } } },
  };
  const pageScheme: PaginationSchemeObject = {
    type: 'pageNumber',
    request: { queryParameters: { page: { role: 'page' } } },
  };
  const tokenScheme: PaginationSchemeObject = {
    type: 'pageToken',
    request: { queryParameters: { cursor: { role: 'pageToken' } } },
  };
  const linkScheme: PaginationSchemeObject = { type: 'nextLink' };

  it('returns null when hasNextPage is false', () => {
    expect(nextCursor(offsetScheme, {}, state({ hasNextPage: false }), 3)).toBeNull();
  });

  it('advances offset by the number of items returned', () => {
    expect(nextCursor(offsetScheme, { offset: 3 }, state(), 3)).toEqual({ offset: 6 });
  });

  it('increments the page number', () => {
    expect(nextCursor(pageScheme, { page: 2 }, state(), 3)).toEqual({ page: 3 });
  });

  it('carries forward the next page token', () => {
    expect(nextCursor(tokenScheme, {}, state({ nextPageToken: 'xyz' }), 3)).toEqual({
      pageToken: 'xyz',
    });
  });

  it('returns null for nextLink schemes (caller follows the link directly)', () => {
    expect(nextCursor(linkScheme, {}, state({ nextLink: 'https://x/2' }), 3)).toBeNull();
  });
});
