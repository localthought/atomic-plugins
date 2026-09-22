import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenApiDocument } from 'syncables';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReflectorConfig } from '../../../src/config/index.js';
import type { AuthProfile, OAuthTokens } from '../../../src/oauth/oauth.js';
import { RemoteStorageManager } from '../../../src/remotestorage/manager.js';
import type { StoredRemoteStorage } from '../../../src/remotestorage/store.js';
import {
  SessionManager,
  type EngineFactory,
} from '../../../src/server/session.js';
import { FileUserStore } from '../../../src/server/user-store.js';
import {
  FileStorageBackend,
  type StorageBackend,
} from '../../../src/sync/storage.js';

const OPTIONS = {
  module: 'reflector',
  clientId: 'https://reflector.example',
  redirectUri: 'https://reflector.example/remotestorage/callback',
};

const RS: StoredRemoteStorage = {
  userAddress: 'bob@storage.example',
  href: 'https://storage.example/bob',
  module: 'reflector',
  token: 'rs-token',
  connectedAt: 1,
};

function tokens(name: string): OAuthTokens {
  return { accessToken: `access-${name}`, expiresAt: 1 };
}

/** Reads the backend the stub engine factory recorded on a session's engine. */
function backendOf(engine: unknown): StorageBackend {
  return (engine as { backend: StorageBackend }).backend;
}

describe('SessionManager (multi-user)', () => {
  let dir: string;
  let config: ReflectorConfig;
  let store: FileUserStore;
  let rs: RemoteStorageManager;
  const engineFactory: EngineFactory = (_config, _document, _tokens, backend) =>
    // The engine is irrelevant here; capture the per-user backend so the test
    // can assert isolation.
    ({ backend }) as unknown as ReturnType<EngineFactory>;

  function newManager(): SessionManager {
    return new SessionManager(
      config,
      {} as OpenApiDocument,
      {} as AuthProfile,
      rs,
      store,
      engineFactory,
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-session-'));
    config = {
      dataDir: dir,
      oauth: { clientId: '', clientSecret: '', redirectUri: '' },
    } as unknown as ReflectorConfig;
    store = new FileUserStore(join(dir, 'users'));
    rs = new RemoteStorageManager(OPTIONS);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps concurrent users separate and addressable by their own cookie', async () => {
    const manager = newManager();
    const alice = await manager.connect(tokens('alice'), { sub: 'alice' });
    const bob = await manager.connect(tokens('bob'), { sub: 'bob' });

    expect(alice.sessionId).not.toBe(bob.sessionId);
    expect(manager.authorized(alice.sessionId)?.account.sub).toBe('alice');
    expect(manager.authorized(bob.sessionId)?.account.sub).toBe('bob');
    // A cookie is not a master key: it only unlocks its own session.
    expect(manager.authorized('nope')).toBeUndefined();
    expect(manager.authorized(undefined)).toBeUndefined();
  });

  it('gives each user an isolated local-files copy directory', async () => {
    const manager = newManager();
    const alice = await manager.connect(tokens('alice'), { sub: 'alice' });
    const bob = await manager.connect(tokens('bob'), { sub: 'bob' });

    const aliceBackend = backendOf(alice.engine);
    const bobBackend = backendOf(bob.engine);
    expect(aliceBackend).toBeInstanceOf(FileStorageBackend);
    const aliceRoot = (aliceBackend as unknown as { root: string }).root;
    const bobRoot = (bobBackend as unknown as { root: string }).root;
    expect(aliceRoot).not.toBe(bobRoot);
    expect(aliceRoot.endsWith(join('copies', 'alice'))).toBe(true);
    expect(bobRoot.endsWith(join('copies', 'bob'))).toBe(true);
  });

  it('disconnects one user without touching the others', async () => {
    const manager = newManager();
    const alice = await manager.connect(tokens('alice'), { sub: 'alice' });
    const bob = await manager.connect(tokens('bob'), { sub: 'bob' });

    await manager.disconnect(alice.sessionId);
    expect(manager.authorized(alice.sessionId)).toBeUndefined();
    expect(manager.authorized(bob.sessionId)?.account.sub).toBe('bob');

    // Persisted removal: a fresh manager restores only bob.
    const restored = newManager();
    await restored.restore();
    expect(restored.authorized(bob.sessionId)?.account.sub).toBe('bob');
    expect(restored.authorized(alice.sessionId)).toBeUndefined();
  });

  it('scopes a remoteStorage connection to the one user who made it', async () => {
    const manager = newManager();
    const alice = await manager.connect(tokens('alice'), { sub: 'alice' });
    const bob = await manager.connect(tokens('bob'), { sub: 'bob' });

    await manager.setRemoteStorage(bob.sessionId, RS);

    expect(manager.storageStatus(manager.authorized(bob.sessionId)).kind).toBe(
      'remotestorage',
    );
    expect(backendOf(manager.authorized(bob.sessionId)!.engine).label).toBe(
      'remoteStorage: bob@storage.example',
    );
    // Alice is unaffected.
    expect(
      manager.storageStatus(manager.authorized(alice.sessionId)).kind,
    ).toBe('local');

    // It survives a restart, and clearing returns bob to local files.
    const restored = newManager();
    await restored.restore();
    expect(
      restored.storageStatus(restored.authorized(bob.sessionId)).kind,
    ).toBe('remotestorage');
    await restored.clearRemoteStorage(bob.sessionId);
    expect(
      restored.storageStatus(restored.authorized(bob.sessionId)).kind,
    ).toBe('local');
  });
});
