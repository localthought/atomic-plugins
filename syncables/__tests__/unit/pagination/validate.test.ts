import { describe, expect, it } from 'vitest';
import { validatePaginationScheme } from '../../../src/pagination/validate.js';

describe('validatePaginationScheme', () => {
  it('accepts a well-formed pageNumber scheme', () => {
    const errors = validatePaginationScheme('offset', {
      type: 'pageNumber',
      request: { queryParameters: { page: { role: 'page' } } },
      response: { bodyFields: { total: { role: 'totalCount' } } },
    });
    expect(errors).toEqual([]);
  });

  it('rejects an invalid type', () => {
    const errors = validatePaginationScheme('offset', {
      // @ts-expect-error deliberately invalid for the test
      type: 'offset',
      request: { queryParameters: { offset: { role: 'offset' } } },
    });
    expect(errors).toEqual([
      expect.stringContaining('type must be one of pageNumber, pageToken, or nextLink'),
    ]);
  });

  it('requires at least one of request or response', () => {
    const errors = validatePaginationScheme('broken', { type: 'pageToken' });
    expect(errors).toEqual([
      expect.stringContaining('must define at least one of "request" or "response"'),
    ]);
  });

  it('rejects an invalid request role', () => {
    const errors = validatePaginationScheme('scheme', {
      type: 'pageToken',
      request: {
        // @ts-expect-error deliberately invalid for the test
        queryParameters: { token: { role: 'totalCount' } },
      },
    });
    expect(errors).toEqual([
      expect.stringContaining(
        'request.queryParameters.token.role is not a valid request role',
      ),
    ]);
  });

  it('rejects an invalid response role', () => {
    const errors = validatePaginationScheme('scheme', {
      type: 'pageToken',
      response: {
        // @ts-expect-error deliberately invalid for the test
        bodyFields: { offset: { role: 'offset' } },
      },
    });
    expect(errors).toEqual([
      expect.stringContaining(
        'response.bodyFields.offset.role is not a valid response role',
      ),
    ]);
  });

  it('allows x- extension roles through without error', () => {
    const errors = validatePaginationScheme('scheme', {
      type: 'pageToken',
      request: {
        queryParameters: {
          // @ts-expect-error deliberately non-standard extension role for the test
          cursor: { role: 'x-custom' },
        },
      },
    });
    expect(errors).toEqual([]);
  });
});
