// @wc-ignore-file
/**
 * Reading the Bank transactions table. Rows carry their values under the
 * drive's own property subjects, which the importer's Set up created from
 * `bankingSchema()` (`../schema.ts`). The app finds them through the row
 * class the table names: its `requires` and `recommends` list the property
 * subjects, and each property carries its shortname.
 */
import type { JSONValue, PluginResource, PluginStore } from './store.js';

export const atomic = {
  parent: 'https://atomicdata.dev/properties/parent',
  isA: 'https://atomicdata.dev/properties/isA',
  shortname: 'https://atomicdata.dev/properties/shortname',
  name: 'https://atomicdata.dev/properties/name',
  requires: 'https://atomicdata.dev/properties/requires',
  recommends: 'https://atomicdata.dev/properties/recommends',
  classtype: 'https://atomicdata.dev/properties/classtype',
  propertyClass: 'https://atomicdata.dev/classes/Property',
} as const;

/** Imported by `../plugin.ts`; never written by this app. */
export const BANK_FIELDS = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
  'bank-booking-date',
  'bank-description',
  'bank-reference',
  'bank-transaction-code',
  'bank-statement',
  'bank-source-id',
  'bank-fingerprint',
] as const;

/** The person's own annotations (DESIGN.md gap 5); the importer never writes them. */
export const NOTE_FIELDS = ['money-category', 'money-note'] as const;

export type BankField = (typeof BANK_FIELDS)[number];
export type NoteField = (typeof NOTE_FIELDS)[number];
export type Shortname = BankField | NoteField;

/** Property subject by shortname, for the ones the row class declares. */
export type Fields = Partial<Record<Shortname, string>>;

export type StatementFormat = 'mt940' | 'camt053';

export interface Txn {
  subject: string;
  account: string;
  currency: string;
  /** Exact signed decimal string. */
  amount: string;
  valueDate: string;
  /** Booking date; the value date when the row has none. */
  bookingDate: string;
  description: string;
  reference: string;
  code: string;
  statement: string;
  sourceId: string;
  fingerprint: string;
  /** From the importer's source identity; `undefined` when it is not one. */
  format?: StatementFormat;
  category: string;
  note: string;
}

const KNOWN = new Set<string>([...BANK_FIELDS, ...NOTE_FIELDS]);

const list = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** Resolves the class's declared properties to the shortnames the app knows. */
export async function resolveFields(
  store: PluginStore,
  rowClass: string,
): Promise<Fields> {
  const klass = await store.getResource(rowClass);
  const subjects = [
    ...new Set([
      ...list(klass.get(atomic.requires)),
      ...list(klass.get(atomic.recommends)),
    ]),
  ];
  const fields: Fields = {};
  const properties = await Promise.all(
    subjects.map(s => store.getResource(s).catch(() => undefined)),
  );

  for (const property of properties) {
    const shortname = property?.get(atomic.shortname);
    if (typeof shortname === 'string' && KNOWN.has(shortname))
      fields[shortname as Shortname] ??= property!.subject;
  }

  return fields;
}

/** The fields without which a row is not a bank transaction at all. */
export const REQUIRED: BankField[] = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
];

export const isBankTable = (fields: Fields) =>
  REQUIRED.every(name => fields[name]);

export const canAnnotate = (fields: Fields) =>
  Boolean(fields['money-category'] && fields['money-note']);

export function formatOf(sourceId: string): StatementFormat | undefined {
  try {
    const parsed: unknown = JSON.parse(sourceId);
    const first = Array.isArray(parsed) ? parsed[0] : undefined;

    return first === 'mt940' || first === 'camt053' ? first : undefined;
  } catch {
    return undefined;
  }
}

export function readRow(
  resource: Pick<PluginResource, 'subject' | 'get'>,
  fields: Fields,
): Txn | undefined {
  const text = (name: Shortname) => {
    const property = fields[name];
    const value = property ? resource.get(property) : undefined;

    return typeof value === 'string' ? value : '';
  };

  const amount = text('bank-amount');
  const account = text('bank-account');
  const currency = text('bank-currency');
  const valueDate = text('bank-value-date');
  if (!amount || !account || !currency || !valueDate) return undefined;
  const sourceId = text('bank-source-id');

  return {
    subject: resource.subject,
    account,
    currency,
    amount,
    valueDate,
    bookingDate: text('bank-booking-date') || valueDate,
    description: text('bank-description'),
    reference: text('bank-reference'),
    code: text('bank-transaction-code'),
    statement: text('bank-statement'),
    sourceId,
    fingerprint: text('bank-fingerprint'),
    format: formatOf(sourceId),
    category: text('money-category'),
    note: text('money-note'),
  };
}

/**
 * Reads `subjects` with at most `concurrency` requests in flight, reporting
 * progress. Unreadable rows are skipped, not fatal: one broken resource
 * should not hide a ledger.
 */
export async function readRows(
  store: PluginStore,
  subjects: string[],
  fields: Fields,
  onProgress?: (loaded: number) => void,
  concurrency = 16,
): Promise<Txn[]> {
  const out: (Txn | undefined)[] = new Array(subjects.length);
  let next = 0;
  let loaded = 0;

  const worker = async () => {
    while (next < subjects.length) {
      const index = next++;
      const resource = await store
        .getResource(subjects[index])
        .catch(() => undefined);
      out[index] = resource ? readRow(resource, fields) : undefined;
      onProgress?.(++loaded);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, subjects.length) }, worker),
  );

  return out.filter((row): row is Txn => row !== undefined);
}
