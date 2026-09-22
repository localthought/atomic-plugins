import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountInfo, OAuthTokens } from '../oauth/oauth.js';
import type { StoredSession } from '../oauth/token-store.js';
import type { StoredRemoteStorage } from '../remotestorage/store.js';

/**
 * One connected user, persisted between restarts. This is the whole record for
 * a single browser session: the OAuth tokens, the account they identify, and —
 * if the user pointed their local-first copy at their own remoteStorage — that
 * connection too. Multiple of these coexist so several people can use one
 * hosted instance without contaminating each other.
 */
export interface StoredUser {
  /** Opaque secret matched against the browser's session cookie. */
  sessionId: string;
  tokens: OAuthTokens;
  account: AccountInfo;
  connectedAt: number;
  /** The user's connected remoteStorage account, if any. */
  remoteStorage?: StoredRemoteStorage | undefined;
}

/**
 * Where connected users are persisted. Records hold secrets (OAuth tokens), so
 * every backend keeps them out of the data set the ZIP download packages.
 *
 * Two implementations exist: {@link FileUserStore} (one owner-only JSON file
 * per user, the default) and the Postgres-backed store (used when
 * `DATABASE_URL` is set, e.g. on an ephemeral host like a Heroku dyno where the
 * filesystem does not persist). Both are keyed by `sessionId` and store the
 * whole {@link StoredUser}, so a save is a full upsert.
 */
export interface UserStore {
  /** Prepares the backing store (e.g. creates the table). Optional. */
  init?(): Promise<void>;
  /** Every persisted user, for rebuilding sessions at startup. */
  load(): Promise<StoredUser[]>;
  /** Upserts the full record for one user. */
  save(user: StoredUser): Promise<void>;
  /** Removes one user (on disconnect). */
  remove(sessionId: string): Promise<void>;
}

/** Legacy single-user files to migrate from, if the multi-user store is empty. */
export interface LegacyPaths {
  /** The old single `tokens.json` written by `TokenStore`. */
  tokenPath?: string;
  /** The old single `remotestorage.json` written by `RemoteStorageStore`. */
  remoteStoragePath?: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * The default store: one file per user at `<dir>/<sessionId>.json`, written
 * owner-only. The filename is url-encoded, but the source of truth for the id
 * is `sessionId` inside the record, so filename encoding never has to be
 * reversed.
 */
export class FileUserStore implements UserStore {
  constructor(
    private readonly dir: string,
    private readonly legacy: LegacyPaths = {},
  ) {}

  private fileFor(sessionId: string): string {
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  async load(): Promise<StoredUser[]> {
    await mkdir(this.dir, { recursive: true });
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    const users: StoredUser[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const user = await readJson<StoredUser>(join(this.dir, name));
      if (user?.sessionId) {
        users.push(user);
      }
    }
    if (users.length === 0) {
      const migrated = await this.migrateLegacy();
      if (migrated) {
        users.push(migrated);
      }
    }
    return users;
  }

  async save(user: StoredUser): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.fileFor(user.sessionId),
      JSON.stringify(user, null, 2),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.fileFor(sessionId), { force: true });
  }

  /**
   * One-time migration: an instance upgraded from the single-user layout has a
   * `tokens.json` (and maybe a `remotestorage.json`) but no per-user files.
   * Fold them into a single multi-user record so the existing connection keeps
   * working across the upgrade. The old files are left in place, untouched.
   */
  private async migrateLegacy(): Promise<StoredUser | undefined> {
    const { tokenPath, remoteStoragePath } = this.legacy;
    if (!tokenPath) {
      return undefined;
    }
    const legacy = await readJson<StoredSession>(tokenPath);
    if (!legacy?.sessionId) {
      return undefined;
    }
    const user: StoredUser = {
      sessionId: legacy.sessionId,
      tokens: legacy.tokens,
      account: legacy.account,
      connectedAt: legacy.connectedAt,
    };
    if (remoteStoragePath) {
      const rs = await readJson<StoredRemoteStorage>(remoteStoragePath);
      if (rs?.token) {
        user.remoteStorage = rs;
      }
    }
    await this.save(user);
    return user;
  }
}
