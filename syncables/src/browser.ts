/**
 * `syncables/browser`: the read path, safe to bundle for a browser (or an
 * iframe plugin). Nothing reachable from this module imports a Node
 * built-in or `js-yaml` — `__tests__/unit/browser/bundle.test.ts` bundles it
 * with esbuild `platform: 'browser'` and fails on any such import — and
 * nothing here calls `fetch`: every request goes through the injected
 * `Transport`.
 *
 * Not included: the mock server, `createApiClient`, and the file-path
 * loaders (`loadOpenApiDocument`, `loadOverlay`). Pass documents and
 * overlays as parsed objects.
 */

export {
  prepareDocument,
  describePlatform,
  readPlatform,
  paginate,
} from './read/read.js';
export type {
  PaginateOptions,
  ReadOptions,
  ReadRecord,
  ReadResult,
} from './read/read.js';
export { mergeQuerySelections } from './read/model.js';
export type { PlatformDescription, QuerySelection } from './read/model.js';
export {
  DATATYPES,
  deriveOntology,
  ontologyShortname,
} from './read/ontology.js';
export type { Datatype, Ontology, Term } from './read/ontology.js';
export { DEFAULT_READ_LIMITS } from './read/pages.js';
export type { ReadLimits } from './read/pages.js';
export { fetchTransport } from './read/transport.js';
export type {
  FetchLike,
  ListMethod,
  Transport,
  TransportRequest,
  TransportResponse,
} from './read/transport.js';

export { applyOverlay } from './openapi/apply-overlay.js';
export type {
  OverlayAction,
  OverlayDocument,
} from './openapi/apply-overlay.js';
export { resolveRefs } from './openapi/resolve-refs.js';
export type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from './openapi/types.js';

export { resolveEffectiveScheme } from './pagination/autodetect.js';
export type { EffectiveScheme } from './pagination/autodetect.js';
export { validatePaginationScheme } from './pagination/validate.js';
export { buildBody, buildQuery } from './pagination/request-builder.js';
export type { PageCursor } from './pagination/request-builder.js';
export { parseLinkHeader } from './pagination/response-parser.js';
export type {
  AutoDetectObject,
  PaginationApplicationObject,
  PaginationResponseState,
  PaginationSchemeObject,
  PaginationSchemesMap,
  RequestRole,
  ResponseRole,
  SchemeType,
} from './pagination/types.js';
