import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { resolveRefs } from './resolve-refs.js';
import type { OpenApiDocument } from './types.js';

export type OpenApiSource = string | Record<string, unknown>;

/**
 * Loads an OpenAPI document from a JSON/YAML file path or an in-memory
 * object, and resolves all local `$ref`s. js-yaml parses JSON as well as
 * YAML, so file format doesn't need to be detected separately.
 */
export async function loadOpenApiDocument(
  source: OpenApiSource,
): Promise<OpenApiDocument> {
  const raw =
    typeof source === 'string'
      ? parseYaml(await readFile(source, 'utf8'))
      : source;
  return resolveRefs(raw) as OpenApiDocument;
}
