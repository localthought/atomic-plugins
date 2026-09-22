import { describe, expect, it } from 'vitest';
import { generateFromSchema } from '../../../src/fake-data/generate.js';

describe('generateFromSchema', () => {
  it('returns the schema example when present', () => {
    expect(generateFromSchema({ type: 'string', example: 'fixed' })).toBe('fixed');
  });

  it('returns the first enum value when present', () => {
    expect(generateFromSchema({ type: 'string', enum: ['a', 'b'] })).toBe('a');
  });

  it('generates an object from properties', () => {
    const value = generateFromSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
      },
    });

    expect(value).toEqual({
      name: expect.any(String),
      age: expect.any(Number),
      active: true,
    });
  });

  it('generates an array with one item matching the items schema', () => {
    const value = generateFromSchema({
      type: 'array',
      items: { type: 'string' },
    });

    expect(value).toEqual([expect.any(String)]);
  });

  it('merges allOf branches into a single object', () => {
    const value = generateFromSchema({
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } } },
        { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      ],
    });

    expect(value).toEqual({
      name: expect.any(String),
      id: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('returns null for an undefined schema', () => {
    expect(generateFromSchema(undefined)).toBeNull();
  });
});
