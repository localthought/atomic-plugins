import { describe, expect, it } from 'vitest';
import {
  parseLinkHeader,
  parsePaginationState,
  readNestedField,
  setNestedField,
} from '../../../src/pagination/response-parser.js';
import type { PaginationSchemeObject } from '../../../src/pagination/types.js';

describe('readNestedField / setNestedField', () => {
  it('reads and writes a nested dot-path', () => {
    const body: Record<string, unknown> = {};
    setNestedField(body, 'pagination.total_count', 42);
    expect(body).toEqual({ pagination: { total_count: 42 } });
    expect(readNestedField(body, 'pagination.total_count')).toBe(42);
  });

  it('reads a flat (non-nested) field', () => {
    expect(readNestedField({ total: 7 }, 'total')).toBe(7);
  });
});

describe('parseLinkHeader', () => {
  it('extracts the rel="next" URL from an RFC 8288 Link header', () => {
    const header =
      '<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=1>; rel="prev"';
    expect(parseLinkHeader(header)).toBe('https://api.example.com/items?page=2');
  });

  it('returns null when there is no rel="next" entry', () => {
    expect(parseLinkHeader('<https://api.example.com/items?page=1>; rel="prev"')).toBeNull();
  });
});

describe('parsePaginationState', () => {
  it('reads nested body fields declared with dotted paths', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      response: {
        bodyFields: {
          'pagination.total_count': { role: 'totalCount' },
          'pagination.count': { role: 'pageSize' },
        },
      },
    };
    const state = parsePaginationState(scheme, {
      pagination: { total_count: 250, count: 25 },
    });
    expect(state.totalCount).toBe(250);
    expect(state.pageSize).toBe(25);
  });

  it('derives hasNextPage from a pageToken scheme', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageToken',
      response: { bodyFields: { nextCursor: { role: 'nextPageToken' } } },
    };
    expect(parsePaginationState(scheme, { nextCursor: 'abc' }).hasNextPage).toBe(true);
    expect(parsePaginationState(scheme, {}).hasNextPage).toBe(false);
  });

  it('derives hasNextPage from currentPage/totalPages on a pageNumber scheme', () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      response: {
        bodyFields: {
          page: { role: 'currentPage' },
          totalPages: { role: 'totalPages' },
        },
      },
    };
    expect(
      parsePaginationState(scheme, { page: 1, totalPages: 3 }).hasNextPage,
    ).toBe(true);
    expect(
      parsePaginationState(scheme, { page: 3, totalPages: 3 }).hasNextPage,
    ).toBe(false);
  });

  it('derives hasNextPage from totalCount vs. items fetched so far, with no currentPage role at all', () => {
    // Mirrors Giphy's real scheme: totalCount + pageSize are reported, but
    // there's no currentPage/totalPages role to count pages from, so the
    // caller's own running item count is what determines hasNextPage.
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      response: { bodyFields: { total_count: { role: 'totalCount' } } },
    };
    expect(
      parsePaginationState(scheme, { total_count: 7 }, {}, 3).hasNextPage,
    ).toBe(true);
    expect(
      parsePaginationState(scheme, { total_count: 7 }, {}, 7).hasNextPage,
    ).toBe(false);
    // Without itemsFetchedSoFar, totalCount alone isn't enough to tell.
    expect(
      parsePaginationState(scheme, { total_count: 7 }).hasNextPage,
    ).toBe(false);
  });

  it('parses a nextLink from a response header, not just the body', () => {
    const scheme: PaginationSchemeObject = {
      type: 'nextLink',
      response: { headers: { Link: { role: 'nextLink' } } },
    };
    const state = parsePaginationState(
      scheme,
      {},
      { link: '<https://api.example.com/items?page=2>; rel="next"' },
    );
    expect(state.nextLink).toBe('https://api.example.com/items?page=2');
    expect(state.hasNextPage).toBe(true);
  });
});
