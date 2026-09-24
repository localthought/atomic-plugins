// @wc-ignore-file
/**
 * Test-only doubles, not bundled: an in-memory `PluginStore` shaped after
 * view-client.js (as in timesheets/app), with an app, its ontology, a row
 * class and a table; and a host proxy relay that answers from the mock
 * proxy's notion fixture the way #52's relay would: provider path in, parsed
 * body out.
 */
import { notionFixture } from '../fixtures/notion/scenario.mjs';
import {
  MAX_GET_MANY,
  type HostProxy,
  type HostProxyRequest,
  type JSONValue,
  type PluginResource,
  type PluginStore,
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
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly hostCalls: { op: string; args: unknown }[];
}

/**
 * `hostApis` adds the store operations atomic-server 007869464 introduced
 * (`getMany`, `openExternal`, `openResource`, `getTheme`, `onThemeChange`),
 * recording their calls in `hostCalls`.
 */
export function fakeStore({
  proxy,
  hostApis = false,
}: { proxy?: HostProxy; hostApis?: boolean } = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [APP, {}],
    [ONTOLOGY, { [PARENT]: APP }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY }],
    [TABLE, { [PARENT]: APP }],
  ]);
  const writes: FakeStore['writes'] = [];
  const hostCalls: FakeStore['hostCalls'] = [];
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
        // Replaces, so a `remove()` persists, as a host commit's `remove` does.
        resources.set(subject, { ...props });
        writes.push({ op: 'save', subject });

        return this;
      },
      async destroy() {
        resources.delete(subject);
      },
    };
  };

  const store: FakeStore = {
    resources,
    writes,
    hostCalls,
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
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(proxy ? { proxy } : {}),
  };

  if (hostApis) {
    store.getMany = async subjects => {
      hostCalls.push({ op: 'getMany', args: subjects.length });
      if (subjects.length > MAX_GET_MANY)
        throw new Error('getMany reads at most 100 subjects at a time');

      return subjects.map(subject => {
        const stored = resources.get(subject);

        return stored ? wrap(subject, stored) : { subject, error: 'Not found' };
      });
    };
    store.openExternal = async url => {
      hostCalls.push({ op: 'openExternal', args: url });

      return { status: 'opened' };
    };
    store.openResource = async subject => {
      hostCalls.push({ op: 'openResource', args: subject });

      return { status: 'opened', subject };
    };
    store.getTheme = () => ({ colorScheme: 'dark' });
    store.onThemeChange = handler => {
      hostCalls.push({ op: 'onThemeChange', args: handler });

      return () => {};
    };
  }

  return store;
}

/** #52's relay in front of the notion fixture, recording every request. */
export function fixtureProxy(
  connectionId = 'conn-1',
  { scenario = 'default' }: { scenario?: string } = {},
) {
  const api = notionFixture({ scenario });
  const calls: HostProxyRequest[] = [];
  let disconnected = false;
  const proxy: HostProxy & {
    calls: HostProxyRequest[];
    api: typeof api;
  } = {
    calls,
    api,
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
        headers: {
          'content-type': 'application/json',
          ...(result.headers ?? {}),
        },
        body: result.body,
      };
    },
    connections: async ({ platform }) =>
      platform === 'notion' && !disconnected ? [{ connectionId, platform }] : [],
    connect: async () => ({ status: 'cancelled' }),
    disconnect: async ({ platform }) => {
      disconnected = true;

      return { status: 'disconnected', platform, connectionIds: [connectionId] };
    },
  };

  return proxy;
}
