import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageAdapter } from 'syncables';
import { FileStorageAdapter } from './file-storage.js';

/** One stored record, flattened out of a backend for the ZIP export. */
export interface ExportRecord {
  namespace: string;
  resource: string;
  id: string;
  value: Record<string, unknown>;
}

/**
 * Where the local-first copy lives. syncables only ever talks to a
 * {@link StorageAdapter}; a backend decides which adapter that is (on-disk
 * files, or the user's remoteStorage account) and knows how to enumerate the
 * whole set for the ZIP download.
 */
export interface StorageBackend {
  /** The syncables storage adapter for one namespace (a calendar id, `_account`). */
  adapter(namespace: string): StorageAdapter;
  /** Every stored record across all namespaces/resources, for the ZIP export. */
  enumerate(): Promise<ExportRecord[]>;
  /** Human-readable label for the UI, e.g. `Local files` or `remoteStorage: me@host`. */
  readonly label: string;
}

/** Decodes an `encodeURIComponent` path segment back to readable text. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The default backend: each record is a JSON file under
 * `<root>/<namespace>/<resource>/<id>.json` (see {@link FileStorageAdapter}).
 * This is the on-disk copy the ZIP has always packaged.
 */
export class FileStorageBackend implements StorageBackend {
  readonly label = 'Local files';

  constructor(private readonly root: string) {}

  adapter(namespace: string): StorageAdapter {
    return new FileStorageAdapter(this.root, namespace);
  }

  async enumerate(): Promise<ExportRecord[]> {
    const records: ExportRecord[] = [];
    // Layout on disk is exactly two levels deep: <namespace>/<resource>/<id>.json.
    let namespaces: string[];
    try {
      namespaces = await readdir(this.root);
    } catch {
      return records;
    }
    for (const namespace of namespaces) {
      let resources: string[];
      try {
        resources = await readdir(join(this.root, namespace));
      } catch {
        continue;
      }
      for (const resource of resources) {
        let files: string[];
        try {
          files = await readdir(join(this.root, namespace, resource));
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.json')) {
            continue;
          }
          try {
            const raw = await readFile(
              join(this.root, namespace, resource, file),
              'utf8',
            );
            records.push({
              namespace: decode(namespace),
              resource: decode(resource),
              id: decode(file.slice(0, -'.json'.length)),
              value: JSON.parse(raw) as Record<string, unknown>,
            });
          } catch {
            // Skip unreadable/partial files rather than failing the whole export.
          }
        }
      }
    }
    return records;
  }
}
