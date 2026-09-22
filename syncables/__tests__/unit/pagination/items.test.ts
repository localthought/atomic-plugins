import { describe, expect, it } from 'vitest';
import { effectiveProperties, itemSchemaFor, locateItemsField } from '../../../src/pagination/items.js';
import type { PaginationSchemeObject } from '../../../src/pagination/types.js';

const scheme: PaginationSchemeObject = {
  type: 'pageNumber',
  request: { queryParameters: { offset: { role: 'offset' } } },
  response: { bodyFields: { 'pagination.total_count': { role: 'totalCount' } } },
};

describe('effectiveProperties', () => {
  it('merges allOf branches into one property map', () => {
    const properties = effectiveProperties({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    });
    expect(Object.keys(properties).sort()).toEqual(['a', 'b']);
  });
});

describe('locateItemsField', () => {
  it('finds the array property not claimed by the pagination scheme', () => {
    const field = locateItemsField(
      {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } },
          pagination: { type: 'object' },
        },
      },
      scheme,
    );
    expect(field).toBe('data');
  });

  it('excludes the scheme metadata field even if it happened to be array-typed', () => {
    const field = locateItemsField(
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' } },
          pagination: { type: 'array', items: { type: 'string' } },
        },
      },
      scheme,
    );
    expect(field).toBe('items');
  });

  it('falls back to common envelope field names with no scheme', () => {
    const field = locateItemsField({
      type: 'object',
      properties: {
        results: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
      },
    });
    expect(field).toBe('results');
  });

  it('returns undefined when nothing looks like an items array', () => {
    const field = locateItemsField({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    expect(field).toBeUndefined();
  });
});

describe('itemSchemaFor', () => {
  it('returns items schema directly for a bare array schema', () => {
    const schema = itemSchemaFor({ type: 'array', items: { type: 'string' } });
    expect(schema).toEqual({ type: 'string' });
  });

  it('returns the items schema of the located envelope field', () => {
    const schema = itemSchemaFor(
      {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        },
      },
      scheme,
    );
    expect(schema).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
  });
});
