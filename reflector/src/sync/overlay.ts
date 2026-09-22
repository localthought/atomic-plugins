import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import type { OpenApiDocument } from 'syncables';

export interface OverlayAction {
  target: string;
  update?: Record<string, unknown>;
  remove?: boolean;
}

export interface OverlayDocument {
  overlay: string;
  info: { title: string; version: string };
  actions: OverlayAction[];
}

export async function loadYamlFile<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, 'utf8')) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(existing: unknown, incoming: unknown): unknown {
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = deepMerge(merged[key], value);
    }
    return merged;
  }
  return incoming;
}

/**
 * Tokenizes an Overlay JSONPath target into property segments. Unlike the
 * minimal parser bundled with syncables, this understands the bracket
 * accessors the Calendar overlays use, e.g.
 * `$.paths['/calendars/{calendarId}/events'].get`, whose quoted key contains
 * dots and slashes that a plain `.split('.')` would mangle.
 */
export function parseTarget(target: string): string[] {
  if (target === '$') {
    return [];
  }
  if (!target.startsWith('$')) {
    throw new Error(
      `Unsupported overlay target "${target}": must start with "$"`,
    );
  }
  const segments: string[] = [];
  let index = 1;
  while (index < target.length) {
    const char = target[index];
    if (char === '.') {
      index += 1;
      let name = '';
      while (
        index < target.length &&
        target[index] !== '.' &&
        target[index] !== '['
      ) {
        name += target[index];
        index += 1;
      }
      if (name) {
        segments.push(name);
      }
    } else if (char === '[') {
      const quote = target[index + 1];
      if (quote !== "'" && quote !== '"') {
        throw new Error(
          `Unsupported overlay target "${target}": bracket keys must be quoted`,
        );
      }
      const end = target.indexOf(quote, index + 2);
      if (end === -1) {
        throw new Error(
          `Unsupported overlay target "${target}": unterminated bracket`,
        );
      }
      segments.push(target.slice(index + 2, end));
      index = end + 1;
      if (target[index] === ']') {
        index += 1;
      }
    } else {
      throw new Error(
        `Unsupported overlay target "${target}": unexpected "${char}"`,
      );
    }
  }
  return segments;
}

function navigate(
  root: Record<string, unknown>,
  segments: string[],
): Record<string, unknown> {
  let node = root;
  for (const segment of segments) {
    let child = node[segment];
    if (child === undefined) {
      child = {};
      node[segment] = child;
    }
    if (!isPlainObject(child)) {
      throw new Error(
        `Overlay target segment "${segment}" does not resolve to an object`,
      );
    }
    node = child;
  }
  return node;
}

/**
 * Applies an OpenAPI Overlay document to `document`, returning a new document.
 * Supports `update` (deep-merged onto the target, creating missing parents)
 * and `remove` actions against `$`, dot-paths, and quoted bracket paths.
 */
export function applyOverlay<T extends Record<string, unknown>>(
  document: T,
  overlay: OverlayDocument,
): T {
  const result = JSON.parse(JSON.stringify(document)) as Record<
    string,
    unknown
  >;
  for (const action of overlay.actions) {
    const segments = parseTarget(action.target);
    if (action.remove) {
      if (segments.length === 0) {
        throw new Error('Overlay cannot remove the document root');
      }
      const parent = navigate(result, segments.slice(0, -1));
      delete parent[segments[segments.length - 1] as string];
    } else if (action.update) {
      const targetNode = navigate(result, segments);
      for (const [key, value] of Object.entries(action.update)) {
        targetNode[key] = deepMerge(targetNode[key], value);
      }
    }
  }
  return result as T;
}

const VALID_REQUEST_ROLES = new Set([
  'page',
  'pageSize',
  'offset',
  'pageToken',
  'cursor',
]);
const VALID_RESPONSE_ROLES = new Set([
  'nextPageToken',
  'nextCursor',
  'nextLink',
  'totalCount',
  'totalPages',
  'pageSize',
  'currentPage',
]);

function fieldRole(field: unknown): string | undefined {
  return isPlainObject(field) && typeof field.role === 'string'
    ? field.role
    : undefined;
}

function keepFields(
  fields: Record<string, unknown> | undefined,
  validRoles: Set<string>,
): Record<string, unknown> | undefined {
  if (!fields) {
    return undefined;
  }
  const kept: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const role = fieldRole(field);
    if (role === undefined || validRoles.has(role)) {
      kept[name] = field;
    }
  }
  return kept;
}

/**
 * The Calendar overlays declare `incrementalSync` pagination schemes (page
 * through with `pageToken`, then persist a `nextSyncToken`). The released
 * syncables engine only knows `pageNumber | pageToken | nextLink` and rejects
 * unknown request/response roles. This normalizes those schemes into the
 * `pageToken` shape syncables walks natively — keeping the `pageToken` /
 * `nextPageToken` mechanics that drive the full read and dropping only the
 * `syncToken` / `nextSyncToken` fields the engine has no role for. The
 * `envelope.itemsField` hint is left intact and harmless: syncables locates
 * the item array from the response schema regardless.
 */
export function adaptSchemesForSyncables(
  document: OpenApiDocument,
): OpenApiDocument {
  const schemes = document.components?.paginationSchemes;
  if (!schemes) {
    return document;
  }
  for (const scheme of Object.values(schemes) as unknown as Record<
    string,
    unknown
  >[]) {
    if (scheme.type === 'incrementalSync') {
      scheme.type = 'pageToken';
    }
    const request = scheme.request as Record<string, unknown> | undefined;
    if (request) {
      request.queryParameters = keepFields(
        request.queryParameters as Record<string, unknown> | undefined,
        VALID_REQUEST_ROLES,
      );
      request.bodyFields = keepFields(
        request.bodyFields as Record<string, unknown> | undefined,
        VALID_REQUEST_ROLES,
      );
    }
    const response = scheme.response as Record<string, unknown> | undefined;
    if (response) {
      response.bodyFields = keepFields(
        response.bodyFields as Record<string, unknown> | undefined,
        VALID_RESPONSE_ROLES,
      );
      response.headers = keepFields(
        response.headers as Record<string, unknown> | undefined,
        VALID_RESPONSE_ROLES,
      );
    }
  }
  return document;
}

function schemeItemsField(scheme: unknown): string {
  const response = (
    scheme as { response?: { envelope?: { itemsField?: unknown } } }
  ).response;
  const field = response?.envelope?.itemsField;
  return typeof field === 'string' ? field : 'items';
}

/**
 * Pins the item array of each paginated list response to the field the
 * overlay's `response.envelope.itemsField` declares. syncables locates the
 * items array as the first array-typed property of the response schema, but
 * Google's list schemas carry sibling arrays too (e.g. `Events` has both
 * `defaultReminders` and `items`), which would otherwise be picked ahead of
 * the real items. Dropping the competing array siblings from the *schema*
 * (not the data) makes the declared field unambiguous. This is exactly what
 * the overlay's envelope declaration is for.
 */
export function pinItemsFields(document: OpenApiDocument): OpenApiDocument {
  const schemes = document.components?.paginationSchemes ?? {};
  for (const item of Object.values(document.paths)) {
    const get = item.get;
    const application = get?.['x-pagination'];
    if (!Array.isArray(application) || application.length === 0) {
      continue;
    }
    const schemeName = (application[0] as { scheme?: string }).scheme;
    const itemsField = schemeItemsField(
      schemeName ? schemes[schemeName] : undefined,
    );
    const schema =
      get?.responses?.['200']?.content?.['application/json']?.schema;
    const properties = schema?.properties;
    if (!properties) {
      continue;
    }
    for (const [name, propSchema] of Object.entries(properties)) {
      if (
        name !== itemsField &&
        (propSchema as { type?: string }).type === 'array'
      ) {
        delete properties[name];
      }
    }
  }
  return document;
}
