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
import { entries } from '../identity.js';
import { parseBankStatement } from '../statement.js';
import {
  atomic,
  BANK_FIELDS,
  NOTE_FIELDS,
  STATEMENT_ROW_FIELDS,
  type Shortname,
} from './rows.js';
import {
  GET_MANY_MAX,
  type ColorScheme,
  type ImporterRun,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';

export const APP = 'did:ad:money-app';
export const IMPORTER = 'did:ad:importer';
export const TABLE = 'did:ad:importer/table';
/** The importer's second table (atomic-server#1768). */
export const STATEMENTS = 'did:ad:importer/statements';
export const STATEMENT_CLASS = 'did:ad:ontology/class/bank-statement-record';
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

/** A stored statement as a test states it, by shortname. */
export type SeedStatement = Partial<Record<Shortname, string>>;

export interface FakeStore extends PluginStore {
  /** Adds statement rows to the statements table. */
  addStatements(rows: SeedStatement[]): string[];
  /** Files handed to `importer.run`, by name. */
  readonly runs: string[];
  /** How often the app asked the person to allow editing. */
  readonly accessRequests: number;
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
  /** Calls made, by op, for asserting batching. */
  readonly calls: { get: number; getMany: number[] };
  /** Subjects the app asked the host to open. */
  readonly opened: string[];
  /** Switches the host between light and dark, as `__atomic_style` does. */
  setScheme(scheme: ColorScheme): void;
}

export function fakeStore({
  rows = [],
  notes = true,
  rowsWritable = false,
  data = 'bank',
  host = 'current',
  scheme = 'light',
  statements = [],
  access = 'none',
  answer = 'grant',
  importRun,
}: {
  statements?: SeedStatement[];
  /** `rowAccess()` at the start (a current host). */
  access?: 'granted' | 'none' | 'unavailable';
  /** What the person says to `requestRowAccess()`. */
  answer?: 'grant' | 'deny';
  /** Overrides `importer.run`; by default it imports like the importer. */
  importRun?: (file?: { name: string; text: string }) => Promise<ImporterRun>;
  /** `legacy`: a host before 007869464, without getMany, theme or openResource. */
  host?: 'current' | 'legacy';
  scheme?: ColorScheme;
  rows?: SeedRow[];
  /** Whether the class declares money-category and money-note (M-5). */
  notes?: boolean;
  rowsWritable?: boolean;
  /** `none`: the app has no table; `other`: a table of some other class. */
  data?: 'bank' | 'none' | 'other';
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>();
  const shortnames: string[] = [...BANK_FIELDS, ...(notes ? NOTE_FIELDS : [])];
  const modern = host === 'current';
  let writable = rowsWritable || (modern && access === 'granted');
  let accessStatus: 'granted' | 'none' | 'unavailable' = access;
  const runs: string[] = [];
  let accessRequests = 0;

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

  if (modern) {
    for (const shortname of STATEMENT_ROW_FIELDS)
      resources.set(property(shortname), {
        [atomic.parent]: ONTOLOGY,
        [atomic.isA]: [atomic.propertyClass],
        [atomic.shortname]: shortname,
      });
    resources.set(STATEMENT_CLASS, {
      [atomic.parent]: ONTOLOGY,
      [atomic.shortname]: 'bank-statement-record',
      [atomic.requires]: [
        'bank-account',
        'bank-currency',
        'bank-period-start',
        'bank-period-end',
        'bank-opening-balance',
        'bank-closing-balance',
        'bank-source-id',
      ].map(property),
      [atomic.recommends]: ['bank-statement', ...STATEMENT_ROW_FIELDS].map(
        property,
      ),
    });
    resources.set(STATEMENTS, {
      [atomic.parent]: IMPORTER,
      [atomic.classtype]: STATEMENT_CLASS,
    });
  }

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

        if (!within(subject) && !(writable && isRow(subject)))
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

  const calls = { get: 0, getMany: [] as number[] };
  const opened: string[] = [];
  const themeListeners = new Set<(t: { colorScheme: ColorScheme }) => void>();
  let colorScheme = scheme;

  const addUnder = (
    parent: string,
    klass: string,
    prefix: string,
    seed: Partial<Record<string, string>>[],
  ) => {
    const subjects = seed.map(row => {
      const subject = `${parent}/${prefix}-${++next}`;
      resources.set(subject, {
        [atomic.parent]: parent,
        [atomic.isA]: [klass],
        ...Object.fromEntries(
          Object.entries(row).map(([k, v]) => [property(k), v]),
        ),
      });

      return subject;
    });
    notify(parent);

    return subjects;
  };

  const store: FakeStore = {
    resources,
    runs,
    get accessRequests() {
      return accessRequests;
    },
    addStatements: seed =>
      addUnder(STATEMENTS, STATEMENT_CLASS, 'statement', seed),
    saves,
    subscribed,
    calls,
    opened,
    setScheme(to) {
      if (to === colorScheme) return;
      colorScheme = to;
      for (const listener of themeListeners) listener({ colorScheme });
    },
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
            ...(modern
              ? {
                  tables: {
                    statements: {
                      table: STATEMENTS,
                      rowClass: STATEMENT_CLASS,
                    },
                  },
                }
              : {}),
          },
    async getResource(subject) {
      calls.get++;
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

  if (host === 'current') {
    store.getMany = async subjects => {
      if (subjects.length > GET_MANY_MAX)
        throw new Error(
          `getMany reads at most ${GET_MANY_MAX} subjects at a time; ask in batches`,
        );
      calls.getMany.push(subjects.length);
      if (held) await held;

      return subjects.map(subject => {
        const stored = resources.get(subject);

        return stored
          ? wrap(subject, stored)
          : { subject, error: `No resource ${subject}` };
      });
    };

    store.getTheme = () => ({ colorScheme });

    store.onThemeChange = handler => {
      themeListeners.add(handler);

      return () => themeListeners.delete(handler);
    };

    store.openResource = async subject => {
      if (!resources.has(subject)) throw new Error(`No resource ${subject}`);
      opened.push(subject);

      return { status: 'opened' as const, subject };
    };
  }

  if (modern) {
    store.rowAccess = async () => ({ status: accessStatus });

    store.requestRowAccess = async () => {
      accessRequests++;

      if (answer === 'grant') {
        accessStatus = 'granted';
        writable = true;

        return { status: 'granted' as const };
      }

      return { status: 'denied' as const, reason: 'Not now' };
    };

    store.importer = {
      async run(args) {
        runs.push(args?.file?.name ?? '(picker)');
        if (importRun) return importRun(args?.file);
        if (!args?.file) return { status: 'cancelled' };

        // Like the importer: new transactions by identity, one statement
        // row per statement, append-only.
        const { format, statements: parsed } = parseBankStatement(
          args.file.text,
        );
        const known = new Set(
          [...resources.values()].map(
            r => r[property('bank-source-id')] as string,
          ),
        );
        const fresh = entries(format, parsed).filter(
          e => !known.has(e.identity),
        );
        store.addRows(
          fresh.map(e => ({
            'bank-account': e.statement.account,
            'bank-currency': e.statement.currency,
            'bank-amount': e.row.amount,
            'bank-value-date': e.row.date,
            'bank-booking-date': e.row.bookingDate,
            'bank-description': e.row.description,
            'bank-reference': e.row.bankReference || e.row.reference,
            'bank-transaction-code': e.row.code,
            'bank-statement': e.statement.number,
            'bank-source-id': e.identity,
            'bank-fingerprint': e.fingerprint,
          })),
        );
        store.addStatements(
          parsed.map(st => ({
            'bank-account': st.account,
            'bank-currency': st.currency,
            'bank-statement': st.number,
            'bank-period-start': st.start,
            'bank-period-end': st.end,
            'bank-opening-balance': st.opening,
            'bank-closing-balance': st.closing,
            'bank-entry-count': String(st.transactions.length),
            'bank-format': format,
            'bank-imported-date': '2026-09-24',
          })),
        );

        return fresh.length
          ? {
              status: 'applied',
              created: fresh.length + parsed.length,
              updated: 0,
              destroyed: 0,
              failed: 0,
            }
          : { status: 'nothing' };
      },
    };
  }

  if (rows.length) store.addRows(rows);
  if (statements.length) store.addStatements(statements);

  return store;
}
