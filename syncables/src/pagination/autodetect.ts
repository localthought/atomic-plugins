import type { OpenApiDocument, OperationObject } from '../openapi/types.js';
import type {
  PaginationApplicationObject,
  PaginationSchemeObject,
} from './types.js';
import { validatePaginationScheme } from './validate.js';

export interface EffectiveScheme {
  schemeName: string;
  scheme: PaginationSchemeObject;
}

/**
 * Schemes that fail validation (spec §9) are excluded here rather than
 * thrown on eagerly — one malformed scheme in a document (see e.g. Giphy's
 * `type: offset`, which isn't a valid scheme type) shouldn't prevent using
 * the rest of the document or its other schemes.
 */
function validSchemes(
  document: OpenApiDocument,
): Map<string, PaginationSchemeObject> {
  const map = new Map<string, PaginationSchemeObject>();
  const schemes = document.components?.paginationSchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (validatePaginationScheme(name, scheme).length === 0) {
      map.set(name, scheme);
    }
  }
  return map;
}

function queryParamNames(operation: OperationObject): Set<string> {
  return new Set(
    (operation.parameters ?? [])
      .filter((parameter) => parameter.in === 'query')
      .map((parameter) => parameter.name),
  );
}

function bodyFieldNames(operation: OperationObject): Set<string> {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  return new Set(Object.keys(schema?.properties ?? {}));
}

/**
 * Default auto-detection rules (spec §6.2/§6.3): a dimension only
 * contributes to the match when the scheme actually declares fields for
 * it — an empty declaration isn't treated as vacuously satisfied, or
 * every scheme with no query parameters would match every operation.
 */
function autoDetectMatches(
  scheme: PaginationSchemeObject,
  operation: OperationObject,
): boolean {
  if (scheme.autoDetect === false) {
    return false;
  }
  const options =
    typeof scheme.autoDetect === 'object' ? scheme.autoDetect : {};
  const requireAll = options.requireAll ?? true;
  const results: boolean[] = [];

  if (options.matchQueryParams ?? true) {
    const required = Object.keys(scheme.request?.queryParameters ?? {});
    if (required.length > 0) {
      const declared = queryParamNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }

  if (options.matchBodyFields ?? true) {
    const required = Object.keys(scheme.request?.bodyFields ?? {});
    if (required.length > 0) {
      const declared = bodyFieldNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }

  if (results.length === 0) {
    return false;
  }
  return requireAll ? results.every(Boolean) : results.some(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, overrides: Partial<T>): T {
  const result: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return result as T;
}

/**
 * Resolves the pagination scheme that applies to an operation: an
 * explicit `x-pagination` application (with overrides merged in) takes
 * priority, falling back to auto-detection against the document's valid
 * `paginationSchemes`.
 */
export function resolveEffectiveScheme(
  document: OpenApiDocument,
  operation: OperationObject,
): EffectiveScheme | undefined {
  const schemes = validSchemes(document);

  const explicit = operation['x-pagination'] as
    | PaginationApplicationObject[]
    | undefined;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const application = explicit[0];
    const base = application ? schemes.get(application.scheme) : undefined;
    if (!application || !base) {
      return undefined;
    }
    return {
      schemeName: application.scheme,
      scheme: application.overrides
        ? deepMerge(base, application.overrides)
        : base,
    };
  }

  for (const [schemeName, scheme] of schemes) {
    if (autoDetectMatches(scheme, operation)) {
      return { schemeName, scheme };
    }
  }
  return undefined;
}
