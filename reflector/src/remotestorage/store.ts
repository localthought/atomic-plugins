import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What Reflector persists about a connected remoteStorage account. The OAuth
 * token here is a secret (an implicit-grant bearer token with no refresh), so
 * it is written with owner-only permissions, outside the data set the ZIP
 * download packages.
 */
export interface StoredRemoteStorage {
  /** The account's user address, e.g. `me@storage.example`. */
  userAddress: string;
  /** Storage root URL discovered via WebFinger; never ends in `/`. */
  href: string;
  /** The storage module (top-level directory) Reflector writes under, e.g. `reflector`. */
  module: string;
  /** OAuth bearer token granting read/write to that module. */
  token: string;
  connectedAt: number;
}

/**
 * Persists the connected remoteStorage account to a single JSON file on disk,
 * so the connection survives a server restart. Mirrors {@link TokenStore}.
 */
export class RemoteStorageStore {
  private cache: StoredRemoteStorage | undefined;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<StoredRemoteStorage | undefined> {
    if (this.loaded) {
      return this.cache;
    }
    try {
      this.cache = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as StoredRemoteStorage;
    } catch {
      this.cache = undefined;
    }
    this.loaded = true;
    return this.cache;
  }

  async save(connection: StoredRemoteStorage): Promise<void> {
    this.cache = connection;
    this.loaded = true;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(connection, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    this.cache = undefined;
    this.loaded = true;
    await rm(this.path, { force: true });
  }
}
