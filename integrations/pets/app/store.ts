// @wc-ignore-file
/**
 * The `store` a drive plugin's `view({ root, store })` receives, provided by
 * the host at runtime (atomic-server `server/src/plugins/assets/view-client.js`,
 * served from `/plugin-ui?format=client`) and never bundled here. Kept in
 * sync with that file by hand; if they disagree, view-client.js is ground
 * truth.
 *
 * A copy of `integrations/timesheets/app/store.ts`, extended with the relay
 * ops atomic-server's `claude/plugin-proxy-relay` branch adds
 * (`connections`, `connect`, response `headers`, request `method`/`body`).
 * Kept per plugin on purpose (strict per-plugin containment); sharing one
 * copy is a maintainer decision, see README.md.
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
  /** Provider path after the proxy's `/proxy/<platform>` prefix; may carry `?query`. */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  /** JSON text. */
  body?: string;
  ifMatch?: string;
}

export interface HostProxyResponse {
  status: number;
  /** Lower-cased; only `link`, `retry-after`, `etag`, `content-type`. */
  headers?: Record<string, string>;
  /** Parsed JSON when the response was JSON, the raw text otherwise. */
  body: unknown;
}

export interface ConnectionReference {
  connectionId: string;
  platform: string;
}

export interface HostProxy {
  request(request: HostProxyRequest): Promise<HostProxyResponse>;
  connections(args: { platform: string }): Promise<ConnectionReference[]>;
  /** Settles only when the person cancels; on consent the page navigates away. */
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
  subscribe(subject: string, handler: () => void): () => void;
  /** Feature-detected: hosts without the relay (atomic-server#1624) lack it. */
  proxy?: HostProxy;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
