/** A row: property subject to value, as `store.getResource(...).props` gives it. */
export type Row = Readonly<Record<string, unknown>>;

/** A shared class, as terms.mjs exports it. */
export interface SharedClass {
  readonly subject: string;
  readonly requires: readonly string[];
  readonly recommends: readonly string[];
}

/**
 * Maps rows of one source class onto one shared class, written per source
 * shape in code. `read` turns a source row into a row keyed by the shared
 * class's property subjects. `write`, when present, turns a patch of shared
 * fields back into a patch of the source row; without it the lens is
 * read-only.
 */
export interface Lens {
  readonly from: string;
  readonly to: string;
  read(row: Row): Row;
  write?(patch: Row, row: Row): Record<string, unknown>;
}

export type Match =
  | { readonly kind: 'shared'; readonly class: SharedClass }
  | { readonly kind: 'lens'; readonly class: SharedClass; readonly lens: Lens };

export interface Reading {
  /** The shared class the values belong to. */
  readonly class: string;
  /** Whether the row was of that class, or reached it through a lens. */
  readonly via: 'shared' | 'lens';
  /** The class's fields that are present, by property subject. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Required fields that are absent: show the row as incomplete, don't skip it. */
  readonly missing: readonly string[];
  readonly complete: boolean;
}

export interface Resolver {
  /** The shared class subjects this resolver renders, for the App's `renders`. */
  readonly classes: readonly string[];
  match(rowClass: string): Match | null;
  accepts(rowClass: string): boolean;
  /** Throws when `rowClass` is neither rendered nor lensed. */
  read(row: Row, rowClass: string): Reading;
  /**
   * The patch to save on the row. Throws on a property that isn't a field of
   * the shared class, or when the lens has no `write`.
   */
  write(patch: Row, rowClass: string, row?: Row): Record<string, unknown>;
}

export declare function createResolver(options: {
  classes: readonly SharedClass[];
  lenses?: readonly Lens[];
}): Resolver;
