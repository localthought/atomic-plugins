// @wc-ignore-file
/**
 * The `store` a drive plugin's `view({ root, store })` receives. It is
 * provided by the host at runtime (atomic-server's
 * `server/src/plugins/assets/view-client.js`, served from
 * `/plugin-ui?format=client`), never bundled here. These types are kept in
 * sync with that file by hand because there is no package to import them
 * from; if they disagree, view-client.js is ground truth.
 *
 * Differences from the Phase 1 scaffold on the unmerged
 * `claude/hopeful-hawking-kqlrdy` branch, checked against view-client.js and
 * `browser/data-browser/src/chunks/AppPage/hostStore.ts`:
 * - `getApp()` resolves to the app's subject string, not an object.
 * - `proxy` is not part of the host today. It is the op this app expects
 *   atomic-server#1624 to add; see `transport.ts`.
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
  path: string;
  query?: Record<string, string>;
}

export interface HostProxyResponse {
  status: number;
  body: unknown;
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
  /**
   * Not provided by any host yet (atomic-server#1624). Feature-detected, never
   * assumed.
   */
  proxy?: {
    request(request: HostProxyRequest): Promise<HostProxyResponse>;
  };
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
