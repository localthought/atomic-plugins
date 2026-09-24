// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests and the screenshot harness, shaped
 * after view-client.js and atomic-server's `hostStore.ts`:
 * - resources buffer `set`/`remove` until `save`;
 * - `query` is a property/value match across the whole "drive";
 * - by default the Bank transactions table is *not* beneath the app, as on a
 *   table's app tab, so `save` on a row is refused with the host's message.
 *   `rowsWritable: true` models a host that lets the app write them.
 * It starts with what the importer's Set up creates: banking properties, the
 * Bank transaction class and an empty table. Test-only; not bundled.
 */
import { atomic, BANK_FIELDS, NOTE_FIELDS, type Shortname } from './rows.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';

export const APP = 'did:ad:money-app';
export const IMPORTER = 'did:ad:importer';
export const TABLE = 'did:ad:importer/table';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:ontology/class/bank-transaction';
export const property = (shortname: string) =>
  `did:ad:ontology/property/${shortname}`;

export const REFUSED =
  'This app may only write its own data. Writing here needs rights its key does not have.';

/** One transaction as a test states it, by shortname. */
export type SeedRow = Partial<Record<Shortname, string>> & {
  'bank-account': string;
  'bank-currency': string;
  'bank-amount': string;
  'bank-value-date': string;
};

/** A synthetic row: an invented bunq-style IBAN, the amount as reference. */
export const seedRow = (
  amount: string,
  date: string,
  extra: Partial<SeedRow> = {},
): SeedRow => {
  const account = extra['bank-account'] ?? 'NL42BUNQ0123456789';
  const currency = extra['bank-currency'] ?? 'EUR';
  const reference = extra['bank-reference'] ?? `REF-${amount}-${date}`;

  return {
    'bank-account': account,
    'bank-currency': currency,
    'bank-amount': amount,
    'bank-value-date': date,
    'bank-booking-date': date,
    'bank-description': `Payment ${amount}`,
    'bank-reference': reference,
    'bank-transaction-code': 'NTRF',
    'bank-statement': '31/1',
    'bank-source-id': JSON.stringify([
      'mt940',
      account,
      currency,
      ['bank', reference],
    ]),
    ...extra,
  };
};

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly saves: { subject: string; propVals: Record<string, JSONValue> }[];
  /** Adds rows to the table, notifying subscribers of the table. */
  addRows(rows: SeedRow[]): string[];
  /** Fails the next `n` saves with `message`. */
  failSaves(n: number, message?: string): void;
  /** Keeps every `getResource` pending until `release()` runs. */
  hold(): () => void;
  /** Subjects with a live subscription. */
  readonly subscribed: Set<string>;
}

export function fakeStore({
  rows = [],
  notes = true,
  rowsWritable = false,
  data = 'bank',
}: {
  rows?: SeedRow[];
  /** Whether the class declares money-category and money-note (M-5). */
  notes?: boolean;
  rowsWritable?: boolean;
  /** `none`: the app has no table; `other`: a table of some other class. */
  data?: 'bank' | 'none' | 'other';
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>();
  const shortnames: string[] = [...BANK_FIELDS, ...(notes ? NOTE_FIELDS : [])];

  resources.set(APP, {});
  resources.set(IMPORTER, {});
  resources.set(ONTOLOGY, { [atomic.parent]: IMPORTER });

  for (const shortname of shortnames)
    resources.set(property(shortname), {
      [atomic.parent]: ONTOLOGY,
      [atomic.isA]: [atomic.propertyClass],
      [atomic.shortname]: shortname,
    });

  resources.set(ROW_CLASS, {
    [atomic.parent]: ONTOLOGY,
    [atomic.shortname]: 'bank-transaction',
    [atomic.requires]: [
      'bank-account',
      'bank-currency',
      'bank-amount',
      'bank-value-date',
      'bank-source-id',
    ].map(property),
    [atomic.recommends]: shortnames
      .filter(s => !['bank-source-id', 'bank-fingerprint'].includes(s))
      .map(property),
  });
  resources.set(TABLE, {
    [atomic.parent]: IMPORTER,
    [atomic.classtype]:
      data === 'other' ? 'did:ad:ontology/class/pet' : ROW_CLASS,
  });
  if (data === 'other')
    resources.set('did:ad:ontology/class/pet', { [atomic.parent]: ONTOLOGY });

  const saves: FakeStore['saves'] = [];
  const listeners = new Map<string, Set<() => void>>();
  const subscribed = new Set<string>();
  let failing = 0;
  let failure = REFUSED;
  let held: Promise<void> | undefined;
  let next = 0;

  const notify = (subject: string) => {
    for (const handler of listeners.get(subject) ?? []) handler();
  };

  const within = (subject: string): boolean => {
    let current: string | undefined = subject;

    for (let depth = 0; current && depth < 12; depth++) {
      if (current === APP) return true;
      const parent: JSONValue = resources.get(current)?.[atomic.parent];
      current = typeof parent === 'string' ? parent : undefined;
    }

    return false;
  };

  const isRow = (subject: string) =>
    resources.get(subject)?.[atomic.parent] === TABLE;

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = { ...stored };
    const changed = new Set<string>();
    const removed = new Set<string>();

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: p => props[p],
      set(p, value) {
        props[p] = value;
        changed.add(p);
        removed.delete(p);

        return this;
      },
      remove(p) {
        delete props[p];
        changed.delete(p);
        removed.add(p);

        return this;
      },
      async save() {
        await Promise.resolve();

        if (failing > 0) {
          failing--;
          throw new Error(failure);
        }

        if (!within(subject) && !(rowsWritable && isRow(subject)))
          throw new Error(REFUSED);
        const propVals = Object.fromEntries(
          [...changed].map(p => [p, props[p]]),
        );
        const current = { ...(resources.get(subject) ?? {}), ...propVals };
        for (const p of removed) delete current[p];
        resources.set(subject, current);
        saves.push({ subject, propVals });
        changed.clear();
        removed.clear();
        notify(subject);

        return this;
      },
      async destroy() {
        resources.delete(subject);
      },
    };
  };

  const store: FakeStore = {
    resources,
    saves,
    subscribed,
    addRows(seed) {
      const subjects = seed.map(row => {
        const subject = `${TABLE}/row-${++next}`;
        resources.set(subject, {
          [atomic.parent]: TABLE,
          [atomic.isA]: [ROW_CLASS],
          ...Object.fromEntries(
            Object.entries(row).map(([k, v]) => [property(k), v]),
          ),
        });

        return subject;
      });
      notify(TABLE);

      return subjects;
    },
    failSaves(n, message = 'Simulated write failure') {
      failing = n;
      failure = message;
    },
    hold() {
      let release!: () => void;
      held = new Promise(resolve => (release = resolve));

      return () => {
        held = undefined;
        release();
      };
    },
    getApp: async () => APP,
    getData: async () =>
      data === 'none'
        ? undefined
        : {
            table: TABLE,
            rowClass: resources.get(TABLE)?.[atomic.classtype] as string,
          },
    async getResource(subject) {
      if (held) await held;
      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property: p, value }) {
      return [...resources.entries()]
        .filter(([, props]) => props[p] === value)
        .map(([subject]) => subject);
    },
    async newResource({ parent, isA = [], propVals = {} } = {}) {
      const subject = `${APP}/new-${++next}`;
      const stored = {
        ...propVals,
        [atomic.parent]: parent ?? APP,
        [atomic.isA]: isA,
      };
      resources.set(subject, stored);

      return wrap(subject, stored);
    },
    subscribe(subject, handler) {
      const set = listeners.get(subject) ?? new Set();
      set.add(handler);
      listeners.set(subject, set);
      subscribed.add(subject);

      return () => {
        set.delete(handler);
        if (!set.size) subscribed.delete(subject);
      };
    },
  };

  if (rows.length) store.addRows(rows);

  return store;
}
