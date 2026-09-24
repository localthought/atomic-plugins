/**
 * `devonian/reflect` for Node and other non-browser runtimes: the portable
 * engine from `browser.ts` plus the JSON-file-backed {@link FileIdMap} and
 * {@link FileKvStore}. Bundlers resolving the `browser` export condition get
 * `browser.ts` instead, which has no Node built-ins.
 */
export * from './browser.js';
export { FileIdMap, FileKvStore } from './file.js';
