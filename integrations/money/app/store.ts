// @wc-ignore-file
/**
 * The `store` a drive app's `view({ root, store })` receives. It is provided
 * by the host at runtime (atomic-server's
 * `server/src/plugins/assets/view-client.js`, served from
 * `/plugin-ui?format=client`), never bundled here. These types are kept in
 * sync with that file by hand because there is no package to import them
 * from; if they disagree, view-client.js is ground truth. Every drive app in
 * this repo keeps its own copy (per-plugin containment).
 *
 * Checked against view-client.js and
 * `browser/data-browser/src/chunks/AppPage/hostStore.ts` at the pinned
 * atomic-server (`.atomic-server-ref`, 8270cdf6a):
 * - `getData()` answers the table the app is a view of (a table's app tab),
 *   or the app's own table, with the row class read off that table.
 * - `query` is a collection over the drive, all pages (500 per page).
 * - Reads are allowed anywhere the signed-in person can read. Writes
 *   (`save`, `destroy`, `newResource`) are refused unless the subject is
 *   beneath the app itself: "This app may only write its own data."
 * - There is no `navigate` op and no op that runs a sandbox importer.
 *
 * Money never uses the host's integration-proxy relay (`store.proxy`), so it
 * is not typed here.
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
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
