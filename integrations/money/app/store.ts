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
 * atomic-server (`.atomic-server-ref`, 007869464):
 * - `getData()` answers the table the app is a view of (a table's app tab),
 *   or the app's own table, with the row class read off that table.
 * - `query` is a collection over the drive, all pages (500 per page).
 * - Reads are allowed anywhere the signed-in person can read. Writes
 *   (`save`, `destroy`, `newResource`) are refused unless the subject is
 *   beneath the app itself: "This app may only write its own data."
 * - There is no op that runs a sandbox importer (atomic-server#1739), and
 *   writes to the table an app views are refused (#1740).
 * - Since the 007869464 pin: `getMany` (at most 100 subjects, errors in
 *   place), `getTheme`/`onThemeChange` (`colorScheme`), `openResource` and
 *   `openExternal`. Typed optional and feature-detected, so the app still
 *   runs on a host without them. Shapes as in `@tomic/plugin` `types.ts`.
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

/** One `getMany` entry, in the order asked. */
export type GetManyEntry = PluginResource | { subject: string; error: string };

export type ColorScheme = 'light' | 'dark';

/** The most subjects one `getMany` call takes. */
export const GET_MANY_MAX = 100;

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
  /** Reads up to `GET_MANY_MAX` resources in one round trip. */
  getMany?(subjects: string[]): Promise<GetManyEntry[]>;
  getTheme?(): { colorScheme: ColorScheme };
  onThemeChange?(
    handler: (theme: { colorScheme: ColorScheme }) => void,
  ): () => void;
  /** Shows a resource in the host page, leaving the app. */
  openResource?(
    subject: string,
  ): Promise<{ status: 'opened'; subject: string }>;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
