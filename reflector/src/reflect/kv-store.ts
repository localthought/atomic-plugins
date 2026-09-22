/**
 * A tiny persisted string→string store — moved to `devonian/reflect`
 * (localthought/atomic-plugins#6); re-exported here since it was already
 * fully generic and reflector still needs it directly (e.g. to build a
 * `FileKvStore` under `DATA_DIR`).
 */
export { InMemoryKvStore, FileKvStore, type KvStore } from 'devonian/reflect';
