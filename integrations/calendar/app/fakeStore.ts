// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app: app -> ontology -> row class, and
 * app -> table. `proxy` answers from the same stateful Google Calendar
 * fixture the mock integration proxy serves
 * (`../fixtures/google-calendar/scenario.mjs`), the way the host's frame
 * client and the integration proxy answer (ontola/atomic-plugins#54):
 * `ifMatch` becomes an `If-Match` header; a connection the page no longer
 * lists throws the page's "Connect again" refusal; a revoked one gets the
 * proxy's `403 not_delegated`. A lost response spends nothing: the same
 * connection works on the next call. Test-only; not bundled.
 */
import { calendarFixture } from '../fixtures/google-calendar/scenario.mjs';
import type {
  ColorScheme,
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
  /** What the proxy would hold after the person connected again. */
  reconnect(): void;
  /** The delegation of `connectionId` revoked at the proxy, elsewhere. */
  revoke(connectionId: string): void;
  /** The next relay call answers with this status instead of reaching the fixture. */
  answerNext(status: number, headers?: Record<string, string>): void;
  /** The next relay call throws, as a failed fetch in the page would. */
  throwNext(message: string): void;
  /** What the app asked the host to open (`openExternal`, `openResource`). */
  readonly opened: { external: string[]; resources: string[] };
  /** The person switches the host between light and dark. */
  setTheme(scheme: ColorScheme): void;
}

export function fakeStore({
  connected = true,
  relay = true,
  hostOps = true,
}: {
  connected?: boolean;
  relay?: boolean;
  /** The operations of pin 007869464: open links and resources, theme, disconnect. */
  hostOps?: boolean;
} = {}): FakeStore {
  const opened: FakeStore['opened'] = { external: [], resources: [] };
  let scheme: ColorScheme = 'light';
  const themeListeners = new Set<(t: { colorScheme: ColorScheme }) => void>();
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
  let canned:
    | { status: number; headers: Record<string, string> }
    | { throws: string }
    | undefined;
  const connections = connected ? ['c1'] : [];
  const revoked = new Set<string>();

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
        const merged = { ...(resources.get(subject) ?? {}), ...props };
        for (const property of removed) delete merged[property];
        removed.clear();
        resources.set(subject, merged);
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
          `No google-calendar connection ${request.connectionId} is delegated to this app. Connect again.`,
        );
      if (revoked.has(request.connectionId))
        return {
          status: 403,
          headers: {},
          body: {
            error: 'not_delegated',
            message: 'the signing agent has no delegation for this connection',
          },
        };

      if (canned) {
        const answer = canned;
        canned = undefined;
        if ('throws' in answer) throw new Error(answer.throws);

        return {
          status: answer.status,
          headers: answer.headers,
          body: { error: { code: answer.status, message: 'Canned' } },
        };
      }

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
    ...(hostOps
      ? {
          async disconnect({ platform }: { platform: string }) {
            const connectionIds = connections.splice(0);

            return { status: 'disconnected' as const, platform, connectionIds };
          },
        }
      : {}),
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
    revoke: connectionId => {
      revoked.add(connectionId);
    },
    answerNext: (status, headers = {}) => {
      canned = { status, headers };
    },
    throwNext: message => {
      canned = { throws: message };
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
    opened,
    setTheme: chosen => {
      scheme = chosen;
      for (const listener of themeListeners) listener({ colorScheme: chosen });
    },
    ...(hostOps
      ? {
          async openExternal(url: string) {
            opened.external.push(url);

            return { status: 'opened' as const };
          },
          async openResource(subject: string) {
            opened.resources.push(subject);

            return { status: 'opened' as const, subject };
          },
          getTheme: () => ({ colorScheme: scheme }),
          onThemeChange(handler: (t: { colorScheme: ColorScheme }) => void) {
            themeListeners.add(handler);

            return () => themeListeners.delete(handler);
          },
        }
      : {}),
  };
}
