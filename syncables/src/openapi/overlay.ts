import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import type { OpenApiSource } from './load.js';

export interface OverlayAction {
  target: string;
  update?: Record<string, unknown>;
  remove?: boolean;
  [key: string]: unknown;
}

export interface OverlayDocument {
  overlay: string;
  info: { title: string; version: string };
  actions: OverlayAction[];
  [key: string]: unknown;
}

/** Loads an OpenAPI Overlay document from a YAML/JSON file path or object. */
export async function loadOverlay(
  source: OpenApiSource,
): Promise<OverlayDocument> {
  const raw =
    typeof source === 'string'
      ? parseYaml(await readFile(source, 'utf8'))
      : source;
  return raw as OverlayDocument;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMergeValue(existing: unknown, incoming: unknown): unknown {
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = deepMergeValue(merged[key], value);
    }
    return merged;
  }
  return incoming;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Parses the intentionally-small subset of Overlay JSONPath targets this
 * library supports: `$` (the document root) or a plain dot-path like
 * `$.components.schemas.Foo`. No wildcards, filters, or bracket/array
 * indexing — every overlay this library has needed to apply so far only
 * targets `$.components`.
 */
function parseTarget(target: string): string[] {
  if (target === '$') {
    return [];
  }
  if (!target.startsWith('$.') || /[[\]*]/.test(target)) {
    throw new Error(
      `Unsupported overlay target "${target}": only "$" or simple dot-paths like "$.components..." are supported`,
    );
  }
  return target.slice(2).split('.');
}

function navigate(
  root: Record<string, unknown>,
  segments: string[],
  createMissing: boolean,
): Record<string, unknown> | undefined {
  let node = root;
  for (const segment of segments) {
    let child = node[segment];
    if (child === undefined) {
      if (!createMissing) {
        return undefined;
      }
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
 * Applies an OpenAPI Overlay (https://spec.openapis.org/overlay/v1.0.0.html)
 * to a document, returning a new document. Supports `update` (deep-merged
 * onto the target) and `remove` actions.
 */
export function applyOverlay<T extends Record<string, unknown>>(
  document: T,
  overlay: OverlayDocument,
): T {
  const result = deepClone(document) as Record<string, unknown>;

  for (const action of overlay.actions) {
    const segments = parseTarget(action.target);
    if (action.remove) {
      if (segments.length === 0) {
        throw new Error('Overlay cannot remove the document root');
      }
      const key = segments[segments.length - 1] as string;
      const parent = navigate(result, segments.slice(0, -1), false);
      if (parent) {
        delete parent[key];
      }
    } else if (action.update) {
      const target = navigate(result, segments, true) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(action.update)) {
        target[key] = deepMergeValue(target[key], value);
      }
    }
  }

  return result as T;
}
