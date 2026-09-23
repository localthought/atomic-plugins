// @wc-ignore-file
/**
 * The `store` a drive plugin's `view({ root, store })` receives from the host
 * (atomic-server `server/src/plugins/assets/view-client.js`). It is never
 * bundled here. The types are kept by hand in step with that file and with
 * timesheets'/pets' copies; there is no package to import them from yet. If
 * they disagree, view-client.js is ground truth.
 *
 * `proxy` is the generic host relay the pets work (#52) adds to
 * atomic-server. It is feature-detected, never assumed: without it the app
 * says so and fetches nothing. Its contract is in that plan: the frame names
 * a platform and a connection id, never a credential; the rotating code stays
 * in the parent page.
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

/** One provider call, relayed by the host. A connection reference, never a credential. */
export interface HostProxyRequest {
  platform: string;
  connectionId: string;
  /** The provider path after the proxy's `/proxy/<platform>`, e.g. `/v1/search`. */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  /** JSON text. */
  body?: string;
}

export interface HostProxyResponse {
  status: number;
  /** Lower-cased, and only an allowlist (`link`, `retry-after`, `etag`, `content-type`). */
  headers?: Record<string, string>;
  /** Parsed JSON when the response parses, the raw text otherwise. */
  body: unknown;
}

export interface HostProxy {
  request(request: HostProxyRequest): Promise<HostProxyResponse>;
  /** Connections this app made for `platform`, in this browser. */
  connections(args: {
    platform: string;
  }): Promise<{ connectionId: string; platform: string }[]>;
  /** Asks the host to show its consent bar; on Connect the page navigates away. */
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
  proxy?: HostProxy;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
