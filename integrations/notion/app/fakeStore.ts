// @wc-ignore-file
/**
 * Test-only doubles, not bundled: an in-memory `PluginStore` shaped after
 * view-client.js (as in timesheets/app), with an app, its ontology, a row
 * class and a table; and a host proxy relay that answers from the mock
 * proxy's notion fixture the way #52's relay would: provider path in, parsed
 * body out.
 */
import { notionFixture } from '../fixtures/notion/scenario.mjs';
import type {
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PARENT = 'https://atomicdata.dev/properties/parent';
export const IS_A = 'https://atomicdata.dev/properties/isA';
export const APP = 'did:ad:app';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class';
export const TABLE = 'did:ad:table';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
}

export function fakeStore({ proxy }: { proxy?: HostProxy } = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [APP, {}],
    [ONTOLOGY, { [PARENT]: APP }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY }],
    [TABLE, { [PARENT]: APP }],
  ]);
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
      const subject = `did:ad:new-${++next}`;
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
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
