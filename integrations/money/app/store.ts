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
 * atomic-server (`.atomic-server-ref`, bc39dac4b):
 * - `getData()` answers the table the app is a view of (a table's app tab),
 *   or the app's own table, with the row class read off that table.
 * - `query` is a collection over the drive, all pages (500 per page).
 * - Reads are allowed anywhere the signed-in person can read. Writes
 *   (`save`, `destroy`, `newResource`) are refused unless the subject is
 *   beneath the app itself: "This app may only write its own data."
 * - Since candidate11 (bc39dac4b): `getData().tables` for an importer's
 *   other tables (#1768), `importer.run` with the host's review (#1774),
 *   and `rowAccess`/`requestRowAccess` for editing the viewed table's rows
 *   (#1788). Without a grant, writes outside the app are still refused.
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
  /**
   * The other tables the importer's Set up created beside this one
   * (manifest `destination.tables`, atomic-server#1768), by key.
   */
  tables?: Record<string, { table: string; rowClass: string }>;
}

/** `store.rowAccess()` (atomic-server#1788). */
export type RowAccess =
  | { status: 'granted'; grantedBy?: string; grantedAt?: number; via?: string }
  | { status: 'none' }
  | { status: 'unavailable' };

/** `store.importer.run()` (atomic-server#1774). */
export type ImporterRun =
  | {
      status: 'applied';
      importer?: string;
      created: number;
      updated: number;
      destroyed: number;
      failed: number;
      errors?: string[];
    }
  | { status: 'nothing' | 'cancelled'; importer?: string }
  | { status: 'blocked'; importer?: string; errors?: string[] };

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
  /** Whether this app may edit the rows of the table it views. */
  rowAccess?(): Promise<RowAccess>;
  /** Asks the person, in the host's bar, to allow editing those rows. */
  requestRowAccess?(): Promise<
    { status: 'granted' } | { status: 'denied'; reason?: string }
  >;
  /** The importer whose table this app views; runs it with host review. */
  importer?: {
    run(args?: {
      file?: { name: string; mediaType: string; text: string };
    }): Promise<ImporterRun>;
  };
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
