// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and
 * atomic-server's `/app-write`:
 * - resources buffer `set` until `save`; `save` is a per-property set, and
 *   properties dropped with `remove()` are removed first, in their own
 *   write, as the host does with atomic-server branch
 *   `claude/app-write-refresh` (at the pin they stayed; `pinnedRemove`);
 * - a write carrying an import baseline must pass the server's
 *   `validate_baseline` (`hostRules.ts`), gets a fresh `approval`, and
 *   `(parent, localId)` is unique;
 * - a write naming a property that is not a Property resource (or one of
 *   Atomic's own) fails, as `value_for` in `store_host.rs` does;
 * - `query` is a property/value match across the whole "drive";
 * - `create` defaults `parent` to the app.
 * `app()` builds what a new App has: the app, an ontology with a row class,
 * and a table of that class. Test-only; not bundled.
 */
import { stamp, validateBaseline } from './hostRules.js';
import { atomic } from './ontology.js';
import { IMPORT_BASELINE, IMPORT_LOCAL_ID } from './reconcile.js';
import type {
  ConnectionReference,
  HostProxyRequest,
  HostProxyResponse,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PARENT = atomic.parent;
export const IS_A = atomic.isA;
export const APP = 'did:ad:app';
export const TABLE = 'did:ad:app/table';
export const ROW_CLASS = 'did:ad:app/ontology/item';
export const ONTOLOGY = 'did:ad:app/ontology';

const BUILT_IN = new Set<string>([
  ...Object.values(atomic),
  'https://atomicdata.dev/properties/classtype',
  IMPORT_BASELINE,
  IMPORT_LOCAL_ID,
]);

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save' | 'remove'; subject: string }[];
  /** Fails the next `n` saves of rows (children of the table). */
  failRowSaves(n: number): void;
}

export function fakeStore({
  proxy,
  connections = [{ platform: 'clockify', connectionId: 'conn-1' }],
  withTable = true,
  pinnedRemove = false,
}: {
  proxy?: (request: HostProxyRequest) => Promise<HostProxyResponse>;
  connections?: ConnectionReference[];
  withTable?: boolean;
  /** The pinned host: `remove()` never reaches the stored resource. */
  pinnedRemove?: boolean;
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([[APP, {}]]);

  if (withTable) {
    resources.set(ONTOLOGY, { [PARENT]: APP, [atomic.properties]: [] });
    resources.set(ROW_CLASS, { [PARENT]: ONTOLOGY, [atomic.recommends]: [] });
    resources.set(TABLE, {
      [PARENT]: APP,
      'https://atomicdata.dev/properties/classtype': ROW_CLASS,
    });
  }

  const writes: FakeStore['writes'] = [];
  let next = 0;
  let failing = 0;

  const check = (propVals: Record<string, JSONValue>) => {
    for (const property of Object.keys(propVals)) {
      if (BUILT_IN.has(property)) continue;
      const isA = resources.get(property)?.[IS_A];
      if (!Array.isArray(isA) || !isA.includes(atomic.propertyClass))
        throw new Error(`${property} is not a property`);
    }
  };

  const unique = (subject: string, value: Record<string, JSONValue>) => {
    const id = value[IMPORT_LOCAL_ID];
    if (id === undefined) return;
    for (const [other, props] of resources)
      if (
        other !== subject &&
        props[IMPORT_LOCAL_ID] === id &&
        props[PARENT] === value[PARENT]
      )
        throw new Error('Import identity already exists; preview again');
  };

  /** One write, checked the way the server checks a commit. */
  const commit = (subject: string, value: Record<string, JSONValue>) => {
    validateBaseline(resources.get(subject), value);
    unique(subject, value);
    resources.set(subject, value);
  };

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = { ...stored };
    const removed = new Set<string>();

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: property => props[property],
      set(property, value) {
        props[property] = value;
        removed.delete(property);

        return this;
      },
      remove(property) {
        delete props[property];
        removed.add(property);

        return this;
      },
      async save() {
        if (failing > 0 && resources.get(subject)?.[PARENT] === TABLE) {
          failing--;
          throw new Error('Simulated write failure');
        }

        check(props);

        if (removed.size && !pinnedRemove) {
          const kept = { ...(resources.get(subject) ?? {}) };
          for (const property of removed) delete kept[property];
          commit(subject, kept);
          writes.push({ op: 'remove', subject });
        }

        removed.clear();
        commit(subject, {
          ...(resources.get(subject) ?? {}),
          ...stamp(props),
        });
        writes.push({ op: 'save', subject });

        return this;
      },
      async destroy() {
        resources.delete(subject);
      },
    };
  };

  return {
    resources,
    writes,
    failRowSaves(n) {
      failing = n;
    },
    getApp: async () => APP,
    getData: async () =>
      withTable ? { table: TABLE, rowClass: ROW_CLASS } : undefined,
    async getResource(subject) {
      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property, value }) {
      return [...resources.entries()]
        .filter(([, props]) => props[property] === value)
        .map(([subject]) => subject);
    },
    async newResource({ parent, isA = [], propVals = {} } = {}) {
      check(propVals);
      const subject = `did:ad:new-${++next}`;
      const stored = {
        ...stamp(propVals),
        [PARENT]: parent ?? APP,
        [IS_A]: isA,
      };
      commit(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(proxy
      ? {
          proxy: {
            request: proxy,
            connections: async ({ platform }) =>
              connections.filter(c => c.platform === platform),
            connect: async () => ({ status: 'cancelled' as const }),
          },
        }
      : {}),
  };
}
