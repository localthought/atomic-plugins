// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js:
 * resources buffer `set` until `save`, `save` merges (app_write.rs `save` is
 * `host.set`), `query` is a property/value match across the whole "drive",
 * and `create` defaults `parent` to the app. Test-only; not bundled.
 */
import type {
  HostProxyRequest,
  HostProxyResponse,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PARENT = 'https://atomicdata.dev/properties/parent';
export const IS_A = 'https://atomicdata.dev/properties/isA';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
}

export function fakeStore({
  app = 'did:ad:app',
  table,
  rowClass,
  appProps = {},
  proxy,
}: {
  app?: string;
  table?: string;
  rowClass?: string;
  appProps?: Record<string, JSONValue>;
  proxy?: (request: HostProxyRequest) => Promise<HostProxyResponse>;
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [app, { ...appProps }],
  ]);
  if (table) resources.set(table, { [PARENT]: app });
  const writes: FakeStore['writes'] = [];
  let next = 0;

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
    getApp: async () => app,
    getData: async () =>
      table ? { table, ...(rowClass ? { rowClass } : {}) } : undefined,
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
      const subject = `did:ad:row-${++next}`;
      const stored = { ...propVals, [PARENT]: parent ?? app, [IS_A]: isA };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(proxy ? { proxy: { request: proxy } } : {}),
  };
}
