import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AccountInfo, OAuthTokens } from './oauth.js';

/** What Reflector persists about the connected account between restarts. */
export interface StoredSession {
  tokens: OAuthTokens;
  account: AccountInfo;
  connectedAt: number;
  /** Opaque secret matched against the browser's session cookie. */
  sessionId: string;
}

/**
 * Persists the connected account's OAuth tokens (access + refresh) and profile
 * to a single JSON file on disk, so a connection survives a server restart and
 * the refresh token is available to mint new access tokens. The file holds
 * secrets, so it is written with owner-only permissions and lives outside the
 * data set that the ZIP download packages.
 */
export class TokenStore {
  private cache: StoredSession | undefined;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<StoredSession | undefined> {
    if (this.loaded) {
      return this.cache;
    }
    try {
      this.cache = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as StoredSession;
    } catch {
      this.cache = undefined;
    }
    this.loaded = true;
    return this.cache;
  }

  async save(session: StoredSession): Promise<void> {
    this.cache = session;
    this.loaded = true;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(session, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /** Persists a refreshed token set while leaving the stored account intact. */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const existing = await this.load();
    if (!existing) {
      return;
    }
    await this.save({ ...existing, tokens });
  }

  async clear(): Promise<void> {
    this.cache = undefined;
    this.loaded = true;
    await rm(this.path, { force: true });
  }
}
