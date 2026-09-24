/**
 * Node-only, JSON-file-backed persistence for the reflection engine:
 * {@link FileIdMap} and {@link FileKvStore}. Kept apart from `id-map.ts` and
 * `kv-store.ts` because they import `node:fs/promises` and `node:path`; the
 * browser build of `devonian/reflect` (the `browser` export condition,
 * `browser.ts`) leaves this module out. In a browser, persist by subclassing
 * {@link InMemoryIdMap} / {@link InMemoryKvStore} over IndexedDB or similar.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InMemoryIdMap, type Link } from './id-map.js';
import { InMemoryKvStore } from './kv-store.js';

/**
 * A JSON-file-backed {@link IdMap}. The whole map is small (one entry per
 * reflected record) and rewritten on each link, owner-only. This survives
 * restarts on a durable disk; on an ephemeral host the map should live in a
 * database instead (wired where the loop is configured).
 */
export class FileIdMap extends InMemoryIdMap {
  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileIdMap> {
    const map = new FileIdMap(path);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { kind: string; a: Link; b: Link }[];
      if (Array.isArray(parsed)) {
        map.load(parsed);
      }
    } catch {
      // No file yet (or unreadable) — start empty.
    }
    return map;
  }

  override async link(kind: string, a: Link, b: Link): Promise<void> {
    this.record(kind, a, b);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries()), { mode: 0o600 });
  }
}

/** JSON-file-backed {@link KvStore}, rewritten on each set, owner-only. */
export class FileKvStore extends InMemoryKvStore {
  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileKvStore> {
    const store = new FileKvStore(path);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        string
      >;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            store.record(k, v);
          }
        }
      }
    } catch {
      // No file yet — start empty.
    }
    return store;
  }

  override async set(key: string, value: string): Promise<void> {
    this.record(key, value);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.snapshot()), {
      mode: 0o600,
    });
  }
}
