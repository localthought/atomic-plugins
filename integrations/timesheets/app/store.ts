// @wc-ignore-file
/**
 * The `store` a drive plugin's `view({ root, store })` receives. It is
 * provided by the host at runtime (atomic-server's
 * `server/src/plugins/assets/view-client.js`, served from
 * `/plugin-ui?format=client`), never bundled here. These types are kept in
 * sync with that file by hand because there is no package to import them
 * from; if they disagree, view-client.js is ground truth. The Pets and Notion
 * apps keep their own copies (per-plugin containment).
 *
 * Checked against view-client.js and
 * `browser/data-browser/src/chunks/AppPage/hostStore.ts` at the pinned
 * atomic-server (`.atomic-server-ref`):
 * - `getApp()` resolves to the app's subject string, not an object.
 * - `save()` sends only the properties set since the last save, plus any
 *   removed with `remove()`; the host writes the removals as an `/app-write`
 *   `remove` and then sets the rest (atomic-server#1690). Afterwards the
 *   host re-reads the resource, so the next `get` sees the write.
 * - `proxy`: `request`, `connections` and `connect`. Since
 *   ontola/atomic-plugins#54 phase 2 view-client.js calls the integration
 *   proxy itself, with a capability from the page and a key only the frame
 *   holds; the frame names a connection id, never a credential.
 *   Feature-detected, never assumed.
 */

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { [key: string]: JSONValue }
  | JSONValue[];

export interface DataRef {
  table: string;
  rowClass?: string;
}

export interface PluginResource {
  readonly subject: string;
  readonly props: Record<string, JSONValue>;
  get(property: string): JSONValue;
  set(property: string, value: JSONValue): PluginResource;
  remove(property: string): PluginResource;
  save(): Promise<PluginResource>;
  destroy(): Promise<void>;
}

/** One proxy call, made by the host's frame client. Carries a connection reference, never a credential. */
export interface HostProxyRequest {
  platform: string;
  connectionId: string;
  /** Provider path after the proxy's `/proxy/<connection>/<platform>` prefix. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  /** JSON text. */
  body?: string;
}

export interface HostProxyResponse {
  status: number;
  /** Lower-cased; only `link`, `retry-after`, `etag`, `content-type`. */
  headers?: Record<string, string>;
  /** Parsed JSON when the response was JSON, the raw text otherwise. */
  body: unknown;
}

/** A connection at the proxy, named by public ids only. */
export interface ConnectionReference {
  platform: string;
  connectionId: string;
}

/** What `proxy.connect` resolves to, when it resolves. */
export type ConnectResult =
  | { status: 'cancelled' }
  | { status: 'connected'; connectionId: string; platform: string };

export interface HostProxy {
  request(request: HostProxyRequest): Promise<HostProxyResponse>;
  /** Connections for `platform` the person delegated to this app, at the proxy. */
  connections(args: { platform: string }): Promise<ConnectionReference[]>;
  /**
   * Shows the host's consent bar. Resolves `connected` when the person picks
   * a connection they already have (the host delegates it to this app; no
   * reload), `cancelled` when they cancel. Connecting a new account sends the
   * page to the proxy and back, which reloads this view, so then it never
   * settles.
   */
  connect(args: { platform: string }): Promise<ConnectResult>;
}

export interface PluginStore {
  getApp(): Promise<string>;
  getData(): Promise<DataRef | undefined>;
  getResource(subject: string): Promise<PluginResource>;
  query(args: { property: string; value: string }): Promise<string[]>;
  newResource(args?: {
    parent?: string;
    isA?: string[];
    propVals?: Record<string, JSONValue>;
  }): Promise<PluginResource>;
  /** `handler` takes no argument; re-fetch via getResource for the new data. */
  subscribe(subject: string, handler: () => void): () => void;
  /** Feature-detected: hosts without integration-proxy support lack it. */
  proxy?: HostProxy;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
