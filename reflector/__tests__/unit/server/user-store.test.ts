import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileUserStore,
  type StoredUser,
} from '../../../src/server/user-store.js';

function user(sessionId: string, sub: string): StoredUser {
  return {
    sessionId,
    account: { sub, email: `${sub}@example.test` },
    connectedAt: 1,
    tokens: { accessToken: `access-${sub}`, expiresAt: 2 },
  };
}

describe('FileUserStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-users-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists multiple users and reloads them all', async () => {
    const store = new FileUserStore(join(dir, 'users'));
    await store.save(user('s1', 'alice'));
    await store.save(user('s2', 'bob'));

    const loaded = await new FileUserStore(join(dir, 'users')).load();
    expect(loaded.map((u) => u.sessionId).sort()).toEqual(['s1', 's2']);
    expect(loaded.find((u) => u.sessionId === 's1')?.account.sub).toBe('alice');
  });

  it('upserts on save and removes only the named user', async () => {
    const store = new FileUserStore(join(dir, 'users'));
    await store.save(user('s1', 'alice'));
    await store.save(user('s2', 'bob'));
    // Re-saving the same session id updates rather than duplicates.
    await store.save({ ...user('s1', 'alice'), connectedAt: 99 });

    await store.remove('s2');
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sessionId).toBe('s1');
    expect(loaded[0]?.connectedAt).toBe(99);
  });

  it('writes user files with owner-only permissions', async () => {
    const store = new FileUserStore(join(dir, 'users'));
    await store.save(user('s1', 'alice'));
    const info = await stat(join(dir, 'users', 's1.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('url-encodes unusual session ids into safe filenames', async () => {
    const store = new FileUserStore(join(dir, 'users'));
    await store.save(user('a/b', 'alice'));
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sessionId).toBe('a/b');
    await store.remove('a/b');
    expect(await store.load()).toHaveLength(0);
  });

  it('migrates a legacy single-user tokens.json + remotestorage.json', async () => {
    const tokenPath = join(dir, 'tokens.json');
    const remoteStoragePath = join(dir, 'remotestorage.json');
    await writeFile(
      tokenPath,
      JSON.stringify({
        sessionId: 'legacy-1',
        tokens: { accessToken: 'legacy-access', expiresAt: 5 },
        account: { sub: 'carol' },
        connectedAt: 42,
      }),
    );
    await writeFile(
      remoteStoragePath,
      JSON.stringify({
        userAddress: 'carol@storage.example',
        href: 'https://storage.example/carol',
        module: 'reflector',
        token: 'rs-token',
        connectedAt: 43,
      }),
    );

    const store = new FileUserStore(join(dir, 'users'), {
      tokenPath,
      remoteStoragePath,
    });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sessionId).toBe('legacy-1');
    expect(loaded[0]?.remoteStorage?.token).toBe('rs-token');

    // Migration wrote a per-user file, so a fresh store finds it without the
    // legacy paths.
    const written = await readFile(join(dir, 'users', 'legacy-1.json'), 'utf8');
    expect(JSON.parse(written).account.sub).toBe('carol');
    const reloaded = await new FileUserStore(join(dir, 'users')).load();
    expect(reloaded).toHaveLength(1);
  });

  it('does not migrate once real users exist', async () => {
    const tokenPath = join(dir, 'tokens.json');
    await writeFile(
      tokenPath,
      JSON.stringify({
        sessionId: 'legacy-1',
        tokens: { accessToken: 'legacy', expiresAt: 5 },
        account: { sub: 'carol' },
        connectedAt: 42,
      }),
    );
    const store = new FileUserStore(join(dir, 'users'), { tokenPath });
    await store.save(user('s1', 'alice'));

    const loaded = await store.load();
    expect(loaded.map((u) => u.sessionId)).toEqual(['s1']);
  });
});
