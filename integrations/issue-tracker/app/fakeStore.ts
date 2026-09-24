// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app (app -> ontology -> row class, and
 * app -> table), like pets' and notion's fakes. `proxy` answers from the same
 * GitHub fixture the mock integration proxy serves
 * (`../fixtures/github-issues/scenario.mjs`), seeded repository included.
 *
 * Two host behaviours the real page has and the adapter must survive can be
 * switched on: `lagReads` (a read after an app write returns the old values
 * that many times) and `hideFromQuery` (a `query` leaves out resources the
 * app created until that many queries later). Test-only; not bundled.
 */
import { githubTracker } from '../fixtures/github-issues/scenario.mjs';
import type {
  ColorScheme,
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';
import { IS_A, NAME, PARENT, PROPERTIES, RECOMMENDS } from './tracker.js';

export const APP = 'did:ad:app';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class-item';
export const TABLE = 'did:ad:table-items';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly github: ReturnType<typeof githubTracker>;
  /** Makes every relayed call fail with this host error until cleared. */
  fail?: string;
  /** Limits `fail` to writes (anything but GET). */
  failWritesOnly?: boolean;
  /** With `failWritesOnly`: the lost write still reached GitHub. */
  lostWriteLands?: boolean;
  /** Answers every relayed call with this status until cleared. */
  status?: number;
  /** Answers every call with this integration-proxy refusal code. */
  refusal?: string;
  lagReads: number;
  hideFromQuery: number;
  /** Host calls counted by name (getResource, getMany, openExternal, …). */
  readonly counts: Record<string, number>;
  /** URLs passed to openExternal. */
  readonly opened: string[];
  readonly disconnected: string[];
  /** The person switching the host between light and dark. */
  setScheme(scheme: ColorScheme): void;
  /** A person editing a row in the data-browser: no app write, no lag. */
  edit(subject: string, props: Record<string, JSONValue>): void;
}

export function fakeStore({
  connected = true,
  relay = true,
  hostApis = true,
}: {
  connected?: boolean;
  relay?: boolean;
  /** The host calls of atomic-server pin 007869464 (getMany, openExternal, …). */
  hostApis?: boolean;
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [APP, { [NAME]: 'New app' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items' }],
  ]);
  /** What a lagging read still returns, and for how many more reads. */
  const stale = new Map<
    string,
    { props: Record<string, JSONValue>; reads: number }
  >();
  /** Created subjects a query still leaves out, and for how many queries. */
  const hidden = new Map<string, number>();
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const github = githubTracker();
  let next = 0;

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = structuredClone(stored);
    /** Removed since the last save; `save` sends them, as view-client.js does. */
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
        const before = resources.get(subject) ?? {};
        if (fake.lagReads)
          stale.set(subject, {
            props: structuredClone(before),
            reads: fake.lagReads,
          });
        // /app-write `save` sets every property sent and removes only the
        // ones `remove` named since the last save.
        const saved = { ...before, ...structuredClone(props) };
        for (const property of removed) delete saved[property];
        removed.clear();
        resources.set(subject, saved);
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
      const write = (request.method ?? 'GET') !== 'GET';

      if (fake.fail && (write || !fake.failWritesOnly)) {
        // A lost response: the host sent it, then heard nothing back.
        if (write && fake.lostWriteLands)
          github.request(
            request.method!,
            new URL(
              `/proxy/github-issues${request.path}`,
              'https://proxy.example',
            ),
            request.body ? JSON.parse(request.body) : {},
          );
        throw new Error(fake.fail);
      }

      if (fake.refusal)
        return {
          status: fake.refusal === 'unknown_connection' ? 404 : 403,
          headers: {},
          body: { error: fake.refusal, message: 'refused by the proxy' },
        };

      if (fake.status)
        return {
          status: fake.status,
          headers: {},
          body: { message: 'Bad credentials' },
        };
      const url = new URL(
        `/proxy/github-issues${request.path}`,
        'https://proxy.example',
      );
      for (const [k, v] of Object.entries(request.query ?? {}))
        url.searchParams.set(k, v);
      const result = github.request(
        request.method ?? 'GET',
        url,
        request.body ? JSON.parse(request.body) : {},
      );

      // Relayed headers arrive lower-cased, as view-client.js passes them.
      const headers = Object.fromEntries(
        Object.entries(
          (result as { headers?: Record<string, string> }).headers ?? {},
        ).map(([k, v]) => [k.toLowerCase(), v]),
      );

      return { status: result.status, headers, body: result.body };
    },
    async connections({ platform }) {
      return connected ? [{ connectionId: 'c1', platform }] : [];
    },
    connect: () => new Promise(() => {}),
    ...(hostApis
      ? {
          async disconnect({ platform }: { platform: string }) {
            const had = connected;
            connected = false;
            fake.disconnected.push(platform);

            return {
              status: 'disconnected' as const,
              platform,
              connectionIds: had ? ['c1'] : [],
            };
          },
        }
      : {}),
  };
  let scheme: ColorScheme = 'light';
  const themeListeners = new Set<(t: { colorScheme: ColorScheme }) => void>();

  const counts: Record<string, number> = {};
  const count = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
  const opened: string[] = [];

  const fake: FakeStore = {
    resources,
    writes,
    calls,
    github,
    lagReads: 0,
    hideFromQuery: 0,
    edit(subject, props) {
      resources.set(subject, { ...resources.get(subject), ...props });
      // The page's own edit: its cache has the new values.
      const lag = stale.get(subject);
      if (lag) lag.props = { ...lag.props, ...structuredClone(props) };
    },
    getApp: async () => APP,
    getData: async () => ({ table: TABLE, rowClass: ROW_CLASS }),
    async getResource(subject) {
      count('getResource');
      const lag = stale.get(subject);

      if (lag && lag.reads > 0) {
        lag.reads--;

        return wrap(subject, lag.props);
      }

      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property, value }) {
      const out: string[] = [];

      for (const [subject, props] of resources) {
        const left = hidden.get(subject);

        if (left) {
          hidden.set(subject, left - 1);
          continue;
        }

        if (props[property] === value) out.push(subject);
      }

      return out;
    },
    async newResource({ parent, isA = [], propVals = {} } = {}) {
      const subject = `did:ad:new-${++next}`;
      const stored = {
        ...structuredClone(propVals),
        [PARENT]: parent ?? APP,
        [IS_A]: isA,
      };
      resources.set(subject, stored);
      if (fake.hideFromQuery) hidden.set(subject, fake.hideFromQuery);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    counts,
    opened,
    disconnected: [],
    setScheme(value) {
      scheme = value;
      for (const listener of themeListeners) listener({ colorScheme: value });
    },
    ...(hostApis
      ? {
          async getMany(subjects: string[]) {
            count('getMany');
            if (subjects.length > 100) throw new Error('getMany: at most 100');
            const out = [];

            for (const subject of subjects) {
              const stored = resources.get(subject);
              out.push(
                stored
                  ? wrap(subject, stale.get(subject)?.props ?? stored)
                  : { subject, error: `No resource ${subject}` },
              );
            }

            return out;
          },
          async openExternal(url: string) {
            count('openExternal');
            opened.push(url);

            return { status: 'opened' as const };
          },
          async openResource(subject: string) {
            return { status: 'opened' as const, subject };
          },
          getTheme: () => ({ colorScheme: scheme }),
          onThemeChange(handler: (t: { colorScheme: ColorScheme }) => void) {
            themeListeners.add(handler);

            return () => themeListeners.delete(handler);
          },
        }
      : {}),
    ...(relay ? { proxy } : {}),
  };

  return fake;
}
