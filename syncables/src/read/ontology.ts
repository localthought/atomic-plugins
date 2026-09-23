import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import { crudResourcesOf, isRecord } from './model.js';

/**
 * Atomic Data datatype URLs (https://atomicdata.dev/datatypes/*), the
 * vocabulary the derived ontology's `Term.datatype` uses. A consumer that
 * wants a different vocabulary maps these one-to-one.
 */
export const DATATYPES = {
  string: 'https://atomicdata.dev/datatypes/string',
  timestamp: 'https://atomicdata.dev/datatypes/timestamp',
  date: 'https://atomicdata.dev/datatypes/date',
  integer: 'https://atomicdata.dev/datatypes/integer',
  float: 'https://atomicdata.dev/datatypes/float',
  boolean: 'https://atomicdata.dev/datatypes/boolean',
  json: 'https://atomicdata.dev/datatypes/json',
} as const;

export type Datatype = (typeof DATATYPES)[keyof typeof DATATYPES];

export interface Term {
  /** `<base>/property/<shortname>` or `<base>/class/<shortname>`. */
  path: string;
  kind: 'class' | 'property';
  shortname: string;
  description: string;
  datatype: Datatype;
  /** Class terms only: paths of the property terms the schema requires. */
  requires: string[];
  /** Class terms only: paths of the remaining property terms. */
  recommends: string[];
}

export interface Ontology {
  description: string;
  terms: Term[];
}

/** `updated_at` -> `updated-at`: lower-case; runs of other characters collapse to one `-`. */
export function ontologyShortname(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

export function datatypeOf(
  schema: SchemaObject | undefined,
): Datatype | undefined {
  switch (schema?.type) {
    case 'string':
      return schema.format === 'date-time'
        ? DATATYPES.timestamp
        : schema.format === 'date'
          ? DATATYPES.date
          : DATATYPES.string;
    case 'integer':
      return DATATYPES.integer;
    case 'number':
      return DATATYPES.float;
    case 'boolean':
      return DATATYPES.boolean;
    default:
      return undefined;
  }
}

/** Merges `allOf` branches (recursively) into one schema's properties and required list. */
export function flattenSchema(schema: SchemaObject | undefined): SchemaObject {
  if (!schema?.allOf) {
    return schema ?? {};
  }
  const { allOf, ...rest } = schema;
  return allOf.map(flattenSchema).reduce<SchemaObject>(
    (merged, branch) => ({
      ...merged,
      required: [...(merged.required ?? []), ...(branch.required ?? [])],
      properties: { ...merged.properties, ...branch.properties },
    }),
    rest,
  );
}

function claim(claimed: Map<string, string>, original: string): string {
  const shortname = ontologyShortname(original);
  const existing = claimed.get(shortname);
  if (existing !== undefined && existing !== original) {
    throw new Error(
      `Ontology shortname ${shortname} is claimed by both ${existing} and ${original}`,
    );
  }
  claimed.set(shortname, original);
  return shortname;
}

/**
 * Derives classes and properties from `components.crudResources`: one class
 * per resource, one property per distinct field shortname across all of
 * them. A field typed differently in two resources, or with no scalar
 * type, gets the `json` datatype. Two different names normalising to the
 * same shortname (`updatedAt`/`updated_at` do not, `updated_at`/`Updated-At`
 * do) throw rather than silently merging. Expects local `$ref`s resolved.
 */
export function deriveOntology(document: OpenApiDocument): Ontology {
  const title = document.info?.title?.trim() ?? '';
  const base = title ? ontologyShortname(title) : 'ontology';
  const terms: Term[] = [];
  const classNames = new Map<string, string>();
  const propertyNames = new Map<string, string>();
  const propertyIndex = new Map<string, number>();
  // The datatype first seen per property; undefined once two resources disagree.
  const agreed = new Map<number, Datatype | undefined>();

  for (const [resource, def] of Object.entries(crudResourcesOf(document))) {
    if (!isRecord(def)) {
      continue;
    }
    const classShortname = claim(classNames, resource);
    const schema = flattenSchema(def['schema'] as SchemaObject | undefined);
    const required = new Set(schema.required ?? []);
    const requires: string[] = [];
    const recommends: string[] = [];

    for (const [field, fieldSchema] of Object.entries(
      schema.properties ?? {},
    )) {
      const shortname = claim(propertyNames, field);
      const datatype = datatypeOf(fieldSchema);
      let index = propertyIndex.get(shortname);

      if (index === undefined) {
        index = terms.length;
        propertyIndex.set(shortname, index);
        agreed.set(index, datatype);
        terms.push({
          path: `${base}/property/${shortname}`,
          kind: 'property',
          shortname,
          description:
            typeof fieldSchema.description === 'string'
              ? fieldSchema.description
              : `\`${field}\` of \`${resource}\`.`,
          datatype: datatype ?? DATATYPES.json,
          requires: [],
          recommends: [],
        });
      } else if (agreed.get(index) !== datatype) {
        agreed.set(index, undefined);
        (terms[index] as Term).datatype = DATATYPES.json;
      }

      (required.has(field) ? requires : recommends).push(
        (terms[index] as Term).path,
      );
    }

    terms.push({
      path: `${base}/class/${classShortname}`,
      kind: 'class',
      shortname: classShortname,
      description:
        typeof def['description'] === 'string'
          ? def['description']
          : `The \`${resource}\` resource.`,
      datatype: DATATYPES.json,
      requires,
      recommends,
    });
  }

  return {
    description: title
      ? `Derived from the "${title}" OpenAPI document.`
      : 'Derived from an OpenAPI document.',
    terms,
  };
}
