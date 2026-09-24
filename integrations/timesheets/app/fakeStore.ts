// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and
 * atomic-server's `/app-write`:
 * - resources buffer `set` until `save`; `save` is a per-property set, so a
 *   property dropped with `remove()` stays on the stored resource;
 * - a write naming a property that is not a Property resource (or one of
 *   Atomic's own) fails, as `value_for` in `store_host.rs` does;
 * - `query` is a property/value match across the whole "drive";
 * - `create` defaults `parent` to the app.
 * `app()` builds what a new App has: the app, an ontology with a row class,
 * and a table of that class. Test-only; not bundled.
 */
import { atomic } from './ontology.js';
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
]);

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  /** Fails the next `n` saves of rows (children of the table). */
  failRowSaves(n: number): void;
}

export function fakeStore({
  proxy,
  connections = [{ platform: 'clockify', connectionId: 'conn-1' }],
  withTable = true,
}: {
  proxy?: (request: HostProxyRequest) => Promise<HostProxyResponse>;
  connections?: ConnectionReference[];
  withTable?: boolean;
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

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = { ...stored };

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: property => props[property],
      set(property, value) {
        props[property] = value;

        return this;
      },
      remove(property) {
        delete props[property];

        return this;
      },
      async save() {
        if (failing > 0 && resources.get(subject)?.[PARENT] === TABLE) {
          failing--;
          throw new Error('Simulated write failure');
        }

        check(props);
        resources.set(subject, { ...(resources.get(subject) ?? {}), ...props });
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
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
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
