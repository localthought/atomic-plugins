import type { SchemaObject } from '../openapi/types.js';

let stringCounter = 0;

/**
 * Synthesizes a value matching a JSON Schema, preferring an `example`
 * on the schema itself when present.
 */
export function generateFromSchema(schema: SchemaObject | undefined): unknown {
  if (!schema) {
    return null;
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.allOf) {
    return schema.allOf.reduce<Record<string, unknown>>((merged, sub) => {
      const value = generateFromSchema(sub);
      return value && typeof value === 'object'
        ? { ...merged, ...(value as Record<string, unknown>) }
        : merged;
    }, {});
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateFromSchema(schema.oneOf[0]);
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateFromSchema(schema.anyOf[0]);
  }

  switch (schema.type) {
    case 'string':
      return generateString(schema);
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'array':
      return [generateFromSchema(schema.items)];
    case 'object':
    case undefined:
      return generateObject(schema);
    default:
      return null;
  }
}

function generateObject(schema: SchemaObject): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    result[key] = generateFromSchema(propertySchema);
  }
  return result;
}

function generateString(schema: SchemaObject): string {
  switch (schema.format) {
    case 'date-time':
      return new Date(0).toISOString();
    case 'date':
      return new Date(0).toISOString().slice(0, 10);
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'email':
      return 'user@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    default:
      stringCounter += 1;
      return `string-${stringCounter}`;
  }
}
