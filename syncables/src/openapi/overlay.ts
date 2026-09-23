import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import type { OpenApiSource } from './load.js';
import type { OverlayDocument } from './apply-overlay.js';

export { applyOverlay } from './apply-overlay.js';
export type { OverlayAction, OverlayDocument } from './apply-overlay.js';

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
