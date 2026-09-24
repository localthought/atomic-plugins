// @wc-ignore-file
import {
  atomic,
  ROW_FIELDS,
  SETTING_FIELDS,
  type Field,
  type RowKey,
  type SettingKey,
} from './ontology.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';

/** The app's table, its row class, and the Property subject of every field. */
export interface Schema {
  table: string;
  rowClass: string;
  ontology: string;
  row: Partial<Record<RowKey, string>>;
  settings: Partial<Record<SettingKey, string>>;
}

export type CompleteSchema = Schema & {
  row: Record<RowKey, string>;
  settings: Record<SettingKey, string>;
};

const list = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

async function locate(store: PluginStore) {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const klass = await store.getResource(data.rowClass);
  const ontologySubject = klass.get(atomic.parent);
  if (typeof ontologySubject !== 'string')
    throw new Error('The row class has no parent ontology to add fields to.');
  const ontology = await store.getResource(ontologySubject);
  const byShortname = new Map<string, PluginResource>();

  for (const subject of list(ontology.get(atomic.properties))) {
    const property = await store.getResource(subject);
    const shortname = property.get(atomic.shortname);
    if (typeof shortname === 'string') byShortname.set(shortname, property);
  }

  return { data, klass, ontology, byShortname };
}

function bind<K extends string>(
  fields: Record<K, Field>,
  byShortname: Map<string, PluginResource>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};

  for (const key of Object.keys(fields) as K[]) {
    const found = byShortname.get(fields[key].shortname);
    if (found && found.get(atomic.datatype) === fields[key].datatype)
      out[key] = found.subject;
  }

  return out;
}

/** Read-only: what exists already. A field with another datatype is not bound. */
export async function findSchema(store: PluginStore): Promise<Schema> {
  const { data, ontology, byShortname } = await locate(store);

  return {
    table: data.table,
    rowClass: data.rowClass!,
    ontology: ontology.subject,
    row: bind(ROW_FIELDS, byShortname),
    settings: bind(SETTING_FIELDS, byShortname),
  };
}

/**
 * Finds or creates one Property per field under the row class's ontology (the
 * app's own subtree, where the host lets an app write), lists new ones in the
 * ontology's `properties`, and adds the row fields to the class's
 * `recommends` so the table shows them as columns. Idempotent: a second run
 * writes nothing. A same-named property with another datatype is an error
 * rather than silently reused or duplicated.
 */
export async function ensureSchema(
  store: PluginStore,
): Promise<CompleteSchema> {
  const { data, klass, ontology, byShortname } = await locate(store);
  const added: string[] = [];

  const ensure = async (field: Field): Promise<string> => {
    const found = byShortname.get(field.shortname);

    if (found) {
      if (found.get(atomic.datatype) !== field.datatype)
        throw new Error(
          `The field "${field.name}" already exists with another datatype.`,
        );

      return found.subject;
    }

    const created = await store.newResource({
      parent: ontology.subject,
      isA: [atomic.propertyClass],
      propVals: {
        [atomic.shortname]: field.shortname,
        [atomic.name]: field.name,
        [atomic.datatype]: field.datatype,
        [atomic.description]: field.description,
      },
    });
    added.push(created.subject);
    byShortname.set(field.shortname, created);

    return created.subject;
  };

  const row = {} as Record<RowKey, string>;
  for (const key of Object.keys(ROW_FIELDS) as RowKey[])
    row[key] = await ensure(ROW_FIELDS[key]);
  const settings = {} as Record<SettingKey, string>;
  for (const key of Object.keys(SETTING_FIELDS) as SettingKey[])
    settings[key] = await ensure(SETTING_FIELDS[key]);

  if (added.length) {
    ontology.set(atomic.properties, [
      ...list(ontology.get(atomic.properties)),
      ...added,
    ]);
    await ontology.save();
  }

  const recommends = list(klass.get(atomic.recommends));
  const wanted = [atomic.name, ...Object.values(row)];
  const missing = wanted.filter(s => !recommends.includes(s));

  if (missing.length) {
    klass.set(atomic.recommends, [...recommends, ...missing]);
    await klass.save();
  }

  return {
    table: data.table,
    rowClass: data.rowClass!,
    ontology: ontology.subject,
    row,
    settings,
  };
}
