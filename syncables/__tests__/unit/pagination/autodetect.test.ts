import { describe, expect, it } from 'vitest';
import { resolveEffectiveScheme } from '../../../src/pagination/autodetect.js';
import type { OpenApiDocument, OperationObject } from '../../../src/openapi/types.js';
import type { PaginationSchemesMap } from '../../../src/pagination/types.js';

function documentWith(paginationSchemes: PaginationSchemesMap): OpenApiDocument {
  return {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {},
    components: { paginationSchemes },
  };
}

const pageNumberScheme = {
  type: 'pageNumber' as const,
  request: { queryParameters: { page: { role: 'page' as const }, limit: { role: 'pageSize' as const } } },
};

describe('resolveEffectiveScheme', () => {
  it('auto-detects a scheme whose query parameters are all present on the operation', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
    };

    const effective = resolveEffectiveScheme(document, operation);
    expect(effective?.schemeName).toBe('pageNumber');
  });

  it('does not match when a required query parameter is missing', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      parameters: [{ name: 'page', in: 'query' }],
    };

    expect(resolveEffectiveScheme(document, operation)).toBeUndefined();
  });

  it('never auto-detects a scheme with autoDetect: false', () => {
    const document = documentWith({
      pageNumber: { ...pageNumberScheme, autoDetect: false },
    });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
    };

    expect(resolveEffectiveScheme(document, operation)).toBeUndefined();
  });

  it('excludes invalid schemes from auto-detection entirely', () => {
    const document = documentWith({
      // @ts-expect-error deliberately invalid type for the test
      broken: { type: 'offset', request: { queryParameters: { page: { role: 'page' } } } },
    });
    const operation: OperationObject = {
      responses: {},
      parameters: [{ name: 'page', in: 'query' }],
    };

    expect(resolveEffectiveScheme(document, operation)).toBeUndefined();
  });

  it('prefers an explicit x-pagination application over auto-detection', () => {
    const document = documentWith({
      pageNumber: pageNumberScheme,
      cursor: { type: 'pageToken', request: { queryParameters: { cursor: { role: 'cursor' } } } },
    });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
      'x-pagination': [{ scheme: 'cursor' }],
    };

    const effective = resolveEffectiveScheme(document, operation);
    expect(effective?.schemeName).toBe('cursor');
  });

  it('deep-merges overrides from an explicit x-pagination application', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      'x-pagination': [
        {
          scheme: 'pageNumber',
          overrides: {
            request: { queryParameters: { limit: { role: 'pageSize', required: true } } },
          },
        },
      ],
    };

    const effective = resolveEffectiveScheme(document, operation);
    expect(effective?.scheme.request?.queryParameters?.['limit']).toEqual({
      role: 'pageSize',
      required: true,
    });
    // Untouched sibling field from the base scheme survives the merge.
    expect(effective?.scheme.request?.queryParameters?.['page']).toEqual({ role: 'page' });
  });
});
