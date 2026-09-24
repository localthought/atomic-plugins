// @wc-ignore-file
import {
  CONTACT_FIELDS,
  contactName,
  contactValues,
  sourceId,
} from './contacts.js';
import {
  readContacts,
  UPSTREAM,
  type MoneybirdGet,
  type MoneybirdResponse,
} from './read.js';
import type {
  ConnectionReference,
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PLATFORM = 'moneybird';

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

/** Row identity; see `sourceId`. */
export const SOURCE_ID = {
  shortname: 'moneybird-source-id',
  name: 'Moneybird source',
  description:
    'Import identity: moneybird:<administration>:contact:<id>. Stable across reads.',
  datatype: `${A}/datatypes/string`,
};
/** The chosen administration, stored on the App resource. */
export const ADMINISTRATION = {
  shortname: 'moneybird-administration',
  name: 'Moneybird administration',
  description: 'The Moneybird administration this app imports from.',
  datatype: `${A}/datatypes/string`,
};

export interface SyncSummary {
  total: number;
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * A `MoneybirdGet` over the host's proxy relay. The frame never holds a
 * credential or calls the network itself; the host's page makes the call.
 */
export function relayGet(
  proxy: HostProxy,
  connection: ConnectionReference,
): MoneybirdGet {
  return async path => {
    if (!path.startsWith('/'))
      throw new Error(`Refusing a Moneybird path: ${path}`);
    const response = await proxy.request({
      platform: connection.platform,
      connectionId: connection.connectionId,
      path,
      method: 'GET',
    });

    return {
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
    } satisfies MoneybirdResponse;
  };
}

export { UPSTREAM };

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** Shortname -> Property subject, creating the missing ones under the ontology. */
export async function ensureProperties(
  store: PluginStore,
  terms: {
    shortname: string;
    name: string;
    description: string;
    datatype: string;
  }[],
): Promise<Map<string, string>> {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const klass = await store.getResource(data.rowClass);
  const ontologySubject = klass.get(PARENT);
  if (typeof ontologySubject !== 'string')
    throw new Error('The row class has no parent ontology to add fields to.');
  const ontology = await store.getResource(ontologySubject);
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = new Map<string, string>();

  for (const subject of listed) {
    const shortname = (await store.getResource(subject)).get(SHORTNAME);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  const created: string[] = [];
  const out = new Map<string, string>();

  for (const term of terms) {
    let subject = byShortname.get(term.shortname);

    if (!subject) {
      subject = (
        await store.newResource({
          parent: ontologySubject,
          isA: [PROPERTY_CLASS],
          propVals: {
            [SHORTNAME]: term.shortname,
            [NAME]: term.name,
            [DESCRIPTION]: term.description,
            [DATATYPE]: term.datatype,
          },
        })
      ).subject;
      created.push(subject);
    }

    out.set(term.shortname, subject);
  }

  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  return out;
}

/**
 * Reads every contact of `administrationId`, then reconciles the app's table.
 *
 * All pages are read before anything is written, so a failed refresh leaves
 * the table exactly as it was. Rows are matched by `moneybird-source-id`; a
 * repeated import with no change on Moneybird writes nothing. Moneybird owns
 * the imported columns: a changed contact overwrites them (local-edit
 * preservation is atomic-plugins#97's policy question). Contacts that
 * disappear from Moneybird are kept, not deleted.
 */
export async function syncContacts(
  store: PluginStore,
  get: MoneybirdGet,
  administrationId: string,
  read: typeof readContacts = readContacts,
): Promise<SyncSummary> {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const contacts = await read(get, administrationId);

  const properties = await ensureProperties(store, [
    SOURCE_ID,
    ...CONTACT_FIELDS,
  ]);
  const klass = await store.getResource(data.rowClass);
  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [NAME, ...properties.values()];
  const merged = [
    ...recommends,
    ...wanted.filter(s => !recommends.includes(s)),
  ];
  if (merged.length !== recommends.length || klass.get(NAME) !== 'Contact')
    await klass.set(RECOMMENDS, merged).set(NAME, 'Contact').save();
  const table = await store.getResource(data.table);
  if (table.get(NAME) !== 'Moneybird contacts')
    await table.set(NAME, 'Moneybird contacts').save();

  const sourceProperty = properties.get(SOURCE_ID.shortname)!;
  const existing = new Map<string, PluginResource>();

  for (const subject of await store.query({
    property: PARENT,
    value: data.table,
  })) {
    const row = await store.getResource(subject);
    const id = row.get(sourceProperty);
    if (typeof id === 'string') existing.set(id, row);
  }

  const summary: SyncSummary = {
    total: contacts.length,
    added: 0,
    updated: 0,
    unchanged: 0,
  };

  for (const contact of contacts) {
    const identity = sourceId(contact, administrationId);
    const propVals: Record<string, JSONValue> = {
      [NAME]: contactName(contact),
      [sourceProperty]: identity,
    };

    for (const [shortname, value] of Object.entries(contactValues(contact)))
      propVals[properties.get(shortname)!] = value;

    const row = existing.get(identity);

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
