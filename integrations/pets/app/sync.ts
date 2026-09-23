// @wc-ignore-file
import {
  readPlatform,
  type OpenApiDocument,
  type ReadResult,
  type Term,
  type Transport,
} from 'syncables/browser';
import openapi from './openapi.json' with { type: 'json' };
import type { JSONValue, PluginResource, PluginStore } from './store.js';

export const PLATFORM = 'pets';
/**
 * The Pets API, bundled: the frame has no YAML parser and needs no catalog
 * fetch. The mock integration proxy serves the same file
 * (`../fixtures/pets/scenario.mjs`).
 */
export const PETS_DOCUMENT = openapi as unknown as OpenApiDocument;

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const PROPERTIES = `${A}/properties/properties`;
export const PROPERTY_CLASS = `${A}/classes/Property`;

export interface SyncSummary {
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Per-collection read failures syncables reported without failing. */
  errors: string[];
}

type Read = (
  document: OpenApiDocument,
  options: Parameters<typeof readPlatform>[1],
) => Promise<ReadResult>;

/** `updated-at` -> `Updated at`. */
export function displayName(shortname: string): string {
  const words = shortname.split('-').join(' ');

  return `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/**
 * Reads every pet through `transport` and reconciles the app's table.
 *
 * Everything written is inside the app's own subtree, which is all a view
 * may write: Properties go under the ontology that holds the table's row
 * class (`createApp` puts both under the app), rows go under the table.
 * `name` maps to Atomic's own name property; the other fields become one
 * Property each, typed from the OpenAPI schema (integer, boolean, float,
 * timestamp), so the table keeps datatypes instead of JSON blobs.
 *
 * Rows are matched by the pet's `id`. A re-sync writes only what changed.
 */
export async function syncPets(
  store: PluginStore,
  transport: Transport,
  { read = readPlatform as Read }: { read?: Read } = {},
): Promise<SyncSummary> {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to sync into.');

  const result = await read(PETS_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport,
  });

  const klass = await store.getResource(data.rowClass);
  const ontologySubject = klass.get(PARENT);
  if (typeof ontologySubject !== 'string')
    throw new Error('The row class has no parent ontology to add fields to.');

  const properties = await ensureProperties(
    store,
    ontologySubject,
    result.ontology.terms.filter(
      t => t.kind === 'property' && t.shortname !== 'name',
    ),
  );

  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [NAME, ...properties.values()];
  const merged = [
    ...recommends,
    ...wanted.filter(s => !recommends.includes(s)),
  ];

  if (merged.length !== recommends.length || klass.get(NAME) !== 'Pet') {
    await klass.set(RECOMMENDS, merged).set(NAME, 'Pet').save();
  }

  const table = await store.getResource(data.table);
  if (table.get(NAME) !== 'Pets') await table.set(NAME, 'Pets').save();

  const idProperty = properties.get('id');
  if (!idProperty) throw new Error('The Pets API document has no id field.');
  const existing = new Map<string, PluginResource>();

  for (const subject of await store.query({
    property: PARENT,
    value: data.table,
  })) {
    const row = await store.getResource(subject);
    const id = row.get(idProperty);
    if (id !== undefined && id !== null) existing.set(String(id), row);
  }

  const summary: SyncSummary = {
    total: result.records.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    errors: result.errors,
  };

  for (const record of result.records) {
    const propVals: Record<string, JSONValue> = { [NAME]: record.name };

    for (const [shortname, value] of Object.entries(record.values)) {
      const property = properties.get(shortname);
      if (property) propVals[property] = value as JSONValue;
    }

    const row = existing.get(record.id);

    if (!row) {
      await store.newResource({
        parent: data.table,
        isA: [data.rowClass],
        propVals,
      });
      summary.added++;
      continue;
    }

    const changed = Object.entries(propVals).filter(
      ([property, value]) => row.get(property) !== value,
    );

    if (changed.length === 0) {
      summary.unchanged++;
      continue;
    }

    for (const [property, value] of changed) row.set(property, value);
    await row.save();
    summary.updated++;
  }

  return summary;
}

/** Shortname -> Property subject, creating the missing ones under `ontology`. */
async function ensureProperties(
  store: PluginStore,
  ontologySubject: string,
  terms: Term[],
): Promise<Map<string, string>> {
  const ontology = await store.getResource(ontologySubject);
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = new Map<string, string>();

  for (const subject of listed) {
    const property = await store.getResource(subject);
    const shortname = property.get(SHORTNAME);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  const created: string[] = [];
  const out = new Map<string, string>();

  for (const term of terms) {
    let subject = byShortname.get(term.shortname);

    if (!subject) {
      const name = displayName(term.shortname);
      const property = await store.newResource({
        parent: ontologySubject,
        isA: [PROPERTY_CLASS],
        propVals: {
          [SHORTNAME]: term.shortname,
          [NAME]: name,
          [DESCRIPTION]:
            term.description || `${name} of a pet, from the Pets API.`,
          [DATATYPE]: term.datatype,
        },
      });
      subject = property.subject;
      created.push(subject);
    }

    out.set(term.shortname, subject);
  }

  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  return out;
}
