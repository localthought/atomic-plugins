import type { SchemaObject } from '../openapi/types.js';
import type { PaginationSchemeObject } from './types.js';

/**
 * Field names real-world APIs commonly wrap a list response in, tried when
 * the response schema itself doesn't unambiguously point at one array
 * property. Matches the heuristic used by the extension's reference
 * client (michielbdejong/openapi-pagination-client).
 */
const COMMON_ITEMS_FIELDS = ['items', 'data', 'results', 'records', 'content'];

/**
 * Flattens a schema's own properties together with any `allOf` branches'
 * properties into one map — real paginated response schemas often compose
 * a shared "paging" base schema with a branch that adds the concrete
 * `items` property (e.g. Spotify's `PagingSimplifiedAlbumObject`).
 */
export function effectiveProperties(
  schema: SchemaObject | undefined,
): Record<string, SchemaObject> {
  if (!schema) {
    return {};
  }
  if (schema.allOf) {
    return schema.allOf.reduce<Record<string, SchemaObject>>(
      (merged, branch) => ({ ...merged, ...effectiveProperties(branch) }),
      {},
    );
  }
  return { ...(schema.properties ?? {}) };
}

/** The top-level field names a pagination scheme claims for its own metadata. */
function metadataFieldRoots(
  scheme: PaginationSchemeObject | undefined,
): Set<string> {
  const roots = new Set<string>();
  for (const key of Object.keys(scheme?.response?.bodyFields ?? {})) {
    roots.add(key.split('.')[0] ?? key);
  }
  return roots;
}

/**
 * Finds the property in a response schema that holds the actual list of
 * items: the first array-typed property that isn't claimed by the
 * pagination scheme as a metadata field, falling back to common
 * enveloping field names.
 */
export function locateItemsField(
  schema: SchemaObject | undefined,
  scheme?: PaginationSchemeObject,
): string | undefined {
  const properties = effectiveProperties(schema);
  const excluded = metadataFieldRoots(scheme);

  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!excluded.has(name) && propertySchema.type === 'array') {
      return name;
    }
  }

  return COMMON_ITEMS_FIELDS.find(
    (name) => name in properties && !excluded.has(name),
  );
}

/** The schema of a single item, given the schema of the whole (enveloped) response. */
export function itemSchemaFor(
  schema: SchemaObject | undefined,
  scheme?: PaginationSchemeObject,
): SchemaObject | undefined {
  if (schema?.type === 'array') {
    return schema.items;
  }
  const field = locateItemsField(schema, scheme);
  return field ? effectiveProperties(schema)[field]?.items : undefined;
}
