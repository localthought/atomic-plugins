/**
 * `devonian/atomic`: the native Atomic Data API on its own — `AtomicStore`,
 * `AtomicIdentityMap`, `AtomicLens` and the resource helpers — without the
 * row API, `effect` schemas or the background scheduler that the package
 * root also exports. Browser-safe; its only runtime dependency is the
 * optional `@tomic/lib` peer (`Datatype`, `validateDatatype`).
 */
export * from './Resource.js';
export * from './Store.js';
export * from './IdentityMap.js';
export * from './Lens.js';
