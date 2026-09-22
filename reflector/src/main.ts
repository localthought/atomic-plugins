import { loadConfig } from './config/index.js';
import { buildDocument } from './sync/document.js';
import { deriveAuthProfile, type AuthProfile } from './oauth/oauth.js';
import { createApp } from './server/app.js';
import { SessionManager } from './server/session.js';
import { FileUserStore, type UserStore } from './server/user-store.js';
import { PostgresUserStore } from './server/user-store-postgres.js';
import { RemoteStorageManager } from './remotestorage/manager.js';
import { ReflectionService } from './reflect/service.js';
import type { ReflectorConfig } from './config/index.js';

/** A placeholder profile for deployments whose document has no OAuth flow (e.g. a token-auth GitHub reflection instance), so the interactive connect flow is simply inert. */
const NO_AUTH_PROFILE: AuthProfile = {
  apiBase: '',
  authorizationUrl: '',
  tokenUrl: '',
  refreshUrl: '',
  scopes: [],
  authorizationParams: {},
};

/**
 * Picks where connected users are persisted: Postgres when `DATABASE_URL` is
 * set (durable on ephemeral hosts), otherwise per-user files on disk. Existing
 * single-user `tokens.json` / `remotestorage.json` are migrated into the file
 * store on first load.
 */
async function createUserStore(config: ReflectorConfig): Promise<UserStore> {
  if (config.databaseUrl) {
    const store = await PostgresUserStore.create(config.databaseUrl);
    await store.init();
    console.log('Reflector: persisting users in Postgres.');
    return store;
  }
  return new FileUserStore(config.usersDir, {
    tokenPath: config.tokenStorePath,
    remoteStoragePath: config.remoteStorage.storePath,
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const document = await buildDocument(config);
  // The interactive connect flow needs an OAuth profile; a token-auth document
  // (e.g. the GitHub reflection instance) declares none, so fall back to an
  // inert profile instead of failing to boot.
  let profile: AuthProfile;
  try {
    profile = deriveAuthProfile(document);
  } catch (error) {
    profile = NO_AUTH_PROFILE;
    console.warn(
      'No OAuth flow in the document; the interactive Connect flow is disabled. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const remoteStorage = new RemoteStorageManager({
    module: config.remoteStorage.module,
    clientId: config.remoteStorage.clientId,
    redirectUri: config.remoteStorage.redirectUri,
  });
  const userStore = await createUserStore(config);
  const sessions = new SessionManager(
    config,
    document,
    profile,
    remoteStorage,
    userStore,
  );
  await sessions.restore();

  const reflection = await ReflectionService.fromConfig(config);

  const app = createApp(config, sessions, profile, remoteStorage, reflection);
  app.listen(config.port, () => {
    console.log(`Reflector listening on ${config.baseUrl}`);
    if (reflection) {
      const { systems, direction, intervalMs } = reflection.status();
      console.log(
        `Reflection enabled (${direction}) between ${systems[0]} and ${systems[1]}, ` +
          `every ${intervalMs}ms. Trigger a pass with POST /api/reflect.`,
      );
      reflection.start();
    } else if (!config.oauth.clientId || !config.oauth.clientSecret) {
      console.warn(
        'Warning: OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set; ' +
          'the "Connect" flow will not work until they are.',
      );
    }
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start Reflector:', error);
  process.exit(1);
});
