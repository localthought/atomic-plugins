import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OpenApiDocument } from 'syncables';
import type { ReflectorConfig } from '../config/index.js';
import { TokenManager } from '../oauth/authed-fetch.js';
import type { AccountInfo, AuthProfile, OAuthTokens } from '../oauth/oauth.js';
import type {
  RemoteStorageManager,
  RemoteStorageStatus,
} from '../remotestorage/manager.js';
import type { StoredRemoteStorage } from '../remotestorage/store.js';
import { SyncEngine } from '../sync/engine.js';
import { FileStorageBackend, type StorageBackend } from '../sync/storage.js';
import type { StoredUser, UserStore } from './user-store.js';

export interface ActiveSession {
  sessionId: string;
  account: AccountInfo;
  connectedAt: number;
  tokens: TokenManager;
  engine: SyncEngine;
  /** The user's connected remoteStorage account, if any. */
  remoteStorage?: StoredRemoteStorage | undefined;
}

/** Builds the sync engine for a session; injectable so tests can stub it. */
export type EngineFactory = (
  config: ReflectorConfig,
  document: OpenApiDocument,
  tokens: TokenManager,
  backend: StorageBackend,
) => SyncEngine;

const defaultEngineFactory: EngineFactory = (
  config,
  document,
  tokens,
  backend,
) => new SyncEngine(config, document, tokens, backend);

/**
 * Turns an account into a filesystem-safe, per-user storage namespace so one
 * user's local-files copy never lands on top of another's. Keyed by the stable
 * OAuth subject where available so reconnecting the same account reuses its
 * copy.
 */
function userKey(account: AccountInfo): string {
  return encodeURIComponent(account.sub ?? account.email ?? 'anonymous');
}

/**
 * Holds every connected user of this Reflector instance, keyed by the opaque
 * session id carried in the browser's cookie. Multiple users coexist, each
 * with their own tokens, their own local-first copy (a per-account directory,
 * or their own remoteStorage account), and their own {@link SyncEngine} — so
 * concurrent users never see or overwrite each other's data.
 *
 * Persistence is delegated to a pluggable {@link UserStore} (files by default,
 * Postgres when `DATABASE_URL` is set), and the in-memory sessions are rebuilt
 * from it on startup.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly records = new Map<string, StoredUser>();

  constructor(
    private readonly config: ReflectorConfig,
    private readonly document: OpenApiDocument,
    private readonly profile: AuthProfile,
    private readonly remoteStorage: RemoteStorageManager,
    private readonly store: UserStore,
    private readonly engineFactory: EngineFactory = defaultEngineFactory,
  ) {}

  /** Rebuilds every session from the persisted users at startup. */
  async restore(): Promise<void> {
    for (const user of await this.store.load()) {
      this.install(user);
    }
  }

  /** Directory a user's local-files copy lives in, isolated per account. */
  private copyRoot(account: AccountInfo): string {
    return join(this.config.dataDir, 'copies', userKey(account));
  }

  /** The storage backend a user's engine should use (remoteStorage or files). */
  private backendFor(user: StoredUser): StorageBackend {
    return (
      this.remoteStorage.backend(user.remoteStorage) ??
      new FileStorageBackend(this.copyRoot(user.account))
    );
  }

  /** Builds and registers the in-memory session for a stored user. */
  private install(user: StoredUser): ActiveSession {
    const tokens = new TokenManager(
      this.profile,
      this.config.oauth,
      user.tokens,
      fetch,
      (next) => {
        // A refresh minted new tokens; persist them against this user only.
        const record = this.records.get(user.sessionId);
        if (record) {
          record.tokens = next;
          void this.store.save(record);
        }
      },
    );
    const session: ActiveSession = {
      sessionId: user.sessionId,
      account: user.account,
      connectedAt: user.connectedAt,
      tokens,
      remoteStorage: user.remoteStorage,
      engine: this.engineFactory(
        this.config,
        this.document,
        tokens,
        this.backendFor(user),
      ),
    };
    this.records.set(user.sessionId, user);
    this.sessions.set(user.sessionId, session);
    return session;
  }

  /** Establishes a new session after a successful OAuth exchange. */
  async connect(
    tokens: OAuthTokens,
    account: AccountInfo,
  ): Promise<ActiveSession> {
    const user: StoredUser = {
      sessionId: randomUUID(),
      tokens,
      account,
      connectedAt: Date.now(),
    };
    await this.store.save(user);
    return this.install(user);
  }

  /** Ends one user's session, leaving every other user untouched. */
  async disconnect(sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      return;
    }
    this.sessions.delete(sessionId);
    this.records.delete(sessionId);
    await this.store.remove(sessionId);
  }

  /** Points a user's copy at their remoteStorage and rebuilds their engine. */
  async setRemoteStorage(
    sessionId: string,
    connection: StoredRemoteStorage,
  ): Promise<void> {
    await this.updateRemoteStorage(sessionId, connection);
  }

  /** Points a user's copy back at local files and rebuilds their engine. */
  async clearRemoteStorage(sessionId: string): Promise<void> {
    await this.updateRemoteStorage(sessionId, undefined);
  }

  private async updateRemoteStorage(
    sessionId: string,
    connection: StoredRemoteStorage | undefined,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const record = this.records.get(sessionId);
    if (!session || !record) {
      return;
    }
    record.remoteStorage = connection;
    session.remoteStorage = connection;
    // A fresh full read repopulates the copy in its new home.
    session.engine = this.engineFactory(
      this.config,
      this.document,
      session.tokens,
      this.backendFor(record),
    );
    await this.store.save(record);
  }

  /** Returns the session the cookie identifies, if it is a known session. */
  authorized(sessionId: string | undefined): ActiveSession | undefined {
    if (!sessionId) {
      return undefined;
    }
    return this.sessions.get(sessionId);
  }

  /** The storage-location status for a session, for the UI. */
  storageStatus(session: ActiveSession | undefined): RemoteStorageStatus {
    return this.remoteStorage.status(session?.remoteStorage);
  }
}
