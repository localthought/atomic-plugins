// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app: app -> ontology -> row class, and
 * app -> table. `proxy` answers from the same stateful Google Calendar
 * fixture the mock integration proxy serves
 * (`../fixtures/google-calendar/scenario.mjs`), the way the page relays:
 * `ifMatch` becomes an `If-Match` header, and a connection whose call threw
 * is spent until the person reconnects (atomic-server
 * `helpers/proxyConnections.ts`). Test-only; not bundled.
 */
import { calendarFixture } from '../fixtures/google-calendar/scenario.mjs';
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
export const DAY = '2026-09-24';

type Fixture = ReturnType<typeof calendarFixture>;

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly google: Fixture;
  /** The next PATCH reaches Google, then the relay throws (a lost response). */
  loseNextWriteResponse(): void;
  /** What the host would hold after the person connected again. */
  reconnect(): void;
}

export function fakeStore({
  connected = true,
  relay = true,
}: { connected?: boolean; relay?: boolean } = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [APP, { [NAME]: 'New app' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items' }],
  ]);
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const google = calendarFixture(DAY);
  let next = 0;
  let loseResponse = false;
  const connections = connected ? ['c1'] : [];
  const spent = new Set<string>();

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
      if (!connections.includes(request.connectionId))
        throw new Error(
          'No google-calendar connection for this app. Connect again.',
        );
      if (spent.has(request.connectionId))
        throw new Error('Reconnect before retrying an uncertain request');
      const url = new URL(
        `/proxy/${request.platform}${request.path}`,
        'http://mock-proxy.test',
      );
      for (const [k, v] of Object.entries(request.query ?? {}))
        url.searchParams.set(k, v);
      const result = google.request(
        request.method ?? 'GET',
        url,
        request.body === undefined ? {} : JSON.parse(request.body),
        request.ifMatch ? { 'if-match': request.ifMatch } : {},
      ) as {
        status: number;
        body: unknown;
        headers?: Record<string, string>;
      };

      if (request.method === 'PATCH' && loseResponse) {
        loseResponse = false;
        spent.add(request.connectionId);
        throw new Error('Failed to fetch');
      }

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
      return connections.map(connectionId => ({ connectionId, platform }));
    },
    connect: () => new Promise(() => {}),
  };

  return {
    resources,
    writes,
    calls,
    google,
    loseNextWriteResponse: () => {
      loseResponse = true;
    },
    reconnect: () => {
      connections.push(`c${connections.length + 1}`);
    },
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
