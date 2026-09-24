// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app: app -> ontology -> row class, and
 * app -> table. `proxy` answers from the same synthetic Moneybird fixture the
 * mock integration proxy serves (`../fixtures/moneybird/scenario.mjs`).
 * Test-only; not bundled. Adapted from `integrations/pets/app/fakeStore.ts`.
 */
import { moneybirdFixture } from '../fixtures/moneybird/scenario.mjs';
import type {
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';
import { IS_A, NAME, PARENT, PROPERTIES, RECOMMENDS } from './sync.js';

export const APP = 'did:ad:app';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class-item';
export const TABLE = 'did:ad:table-items';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly fixture: ReturnType<typeof moneybirdFixture>;
}

export function fakeStore({
  connected = true,
  relay = true,
  outage = true,
}: { connected?: boolean; relay?: boolean; outage?: boolean } = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [APP, { [NAME]: 'New app' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items' }],
  ]);
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const fixture = moneybirdFixture({ outage });
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

  const proxy: HostProxy = {
    async request(request) {
      calls.push(request);
      const url = new URL(
        `/proxy/${request.platform}${request.path}`,
        'https://proxy.example',
      );
      const result = fixture.request(request.method ?? 'GET', url);

      return {
        status: result.status,
        headers: Object.fromEntries(
          Object.entries(result.headers ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            String(v),
          ]),
        ),
        body: result.body,
      };
    },
    async connections({ platform }) {
      return connected ? [{ connectionId: 'c1', platform }] : [];
    },
    connect: () => new Promise(() => {}),
  };

  return {
    resources,
    writes,
    calls,
    fixture,
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
    ...(relay ? { proxy } : {}),
  };
}
