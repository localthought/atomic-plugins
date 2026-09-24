// @wc-ignore-file
/**
 * Test-only doubles, not bundled: an in-memory `PluginStore` shaped after
 * view-client.js (as in timesheets/app), with an app, its ontology, a row
 * class and a table; and a host proxy relay that answers from the mock
 * proxy's notion fixture the way #52's relay would: provider path in, parsed
 * body out.
 *
 * Writes follow the host with atomic-server branch `claude/app-write-refresh`:
 * properties dropped with `remove()` are removed first, in their own write,
 * then `save` sets the rest (`pinnedRemove` models the pinned host, where
 * removals never arrive). A write carrying an import baseline must pass the
 * server's `validate_baseline` (`hostRules.ts`) and gets a fresh `approval`;
 * `(parent, localId)` is unique.
 */
import { notionFixture } from '../fixtures/notion/scenario.mjs';
import { stamp, validateBaseline } from './hostRules.js';
import { IMPORT_LOCAL_ID } from './reconcile.js';
import type {
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PARENT = 'https://atomicdata.dev/properties/parent';
export const IS_A = 'https://atomicdata.dev/properties/isA';
// atomic-server's own subject form (`atomic:<id>`), which is neither HTTP(S)
// nor a DID: what the lens store must never be handed directly.
export const APP = 'atomic:app';
export const ONTOLOGY = 'atomic:ontology';
export const ROW_CLASS = 'atomic:class';
export const TABLE = 'atomic:table';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save' | 'remove'; subject: string }[];
}

export function fakeStore({
  proxy,
  pinnedRemove = false,
}: { proxy?: HostProxy; pinnedRemove?: boolean } = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [APP, {}],
    [ONTOLOGY, { [PARENT]: APP }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY }],
    [TABLE, { [PARENT]: APP }],
  ]);
  const writes: FakeStore['writes'] = [];
  let next = 0;

  /** One write, checked the way the server checks a commit. */
  const commit = (subject: string, value: Record<string, JSONValue>) => {
    validateBaseline(resources.get(subject), value);
    const id = value[IMPORT_LOCAL_ID];
    if (id !== undefined)
      for (const [other, props] of resources)
        if (
          other !== subject &&
          props[IMPORT_LOCAL_ID] === id &&
          props[PARENT] === value[PARENT]
        )
          throw new Error('Import identity already exists; preview again');
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
        if (removed.size && !pinnedRemove) {
          const kept = { ...resources.get(subject) };
          for (const property of removed) delete kept[property];
          commit(subject, kept);
          writes.push({ op: 'remove', subject });
        }

        removed.clear();
        commit(subject, { ...resources.get(subject), ...stamp(props) });
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
    getApp: async () => APP,
    getData: async () => ({ table: TABLE, rowClass: ROW_CLASS }),
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
      const subject = `atomic:new-${++next}`;
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
    ...(proxy ? { proxy } : {}),
  };
}

/** #52's relay in front of the notion fixture, recording every request. */
export function fixtureProxy(connectionId = 'conn-1') {
  const api = notionFixture();
  const calls: HostProxyRequest[] = [];
  const proxy: HostProxy & { calls: HostProxyRequest[] } = {
    calls,
    async request(request) {
      calls.push(request);
      if (
        request.connectionId !== connectionId ||
        request.platform !== 'notion'
      )
        return { status: 401, headers: {}, body: { error: 'no connection' } };
      const url = new URL(`http://mock/proxy/notion${request.path}`);
      const result = api.request(
        request.method ?? 'GET',
        url,
        request.body === undefined ? undefined : JSON.parse(request.body),
      );

      return {
        status: result.status,
        headers: { 'content-type': 'application/json' },
        body: result.body,
      };
    },
    connections: async ({ platform }) =>
      platform === 'notion' ? [{ connectionId, platform }] : [],
    connect: async () => ({ status: 'cancelled' }),
  };

  return proxy;
}
