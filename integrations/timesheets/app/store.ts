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
 * - `proxy` is the relay from atomic-server#1657 (for #1624): `request`,
 *   `connections` and `connect`. Feature-detected, never assumed.
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

/** One proxy call relayed by the host. Carries a connection reference, never a credential. */
export interface HostProxyRequest {
  platform: string;
  connectionId: string;
  /** Provider path after the proxy's `/proxy/<platform>` prefix. */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

/** A connection held by the host page, named by public ids only. */
export interface ConnectionReference {
  platform: string;
  connectionId: string;
}

export interface HostProxy {
  request(request: HostProxyRequest): Promise<HostProxyResponse>;
  /** This app's connections for `platform`, in this browser. */
  connections(args: { platform: string }): Promise<ConnectionReference[]>;
  /** Shows the host's consent bar; settles only when the person cancels. */
  connect(args: { platform: string }): Promise<{ status: 'cancelled' }>;
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
  /** Feature-detected: hosts without the relay (atomic-server#1624) lack it. */
  proxy?: HostProxy;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
