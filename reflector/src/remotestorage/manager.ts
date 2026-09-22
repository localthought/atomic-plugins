import { randomUUID } from 'node:crypto';
import type { StorageBackend } from '../sync/storage.js';
import { RemoteStorageBackend } from './adapter.js';
import { listFolder } from './protocol.js';
import type { StoredRemoteStorage } from './store.js';
import { discover } from './webfinger.js';

/** How the manager is told to build OAuth authorize URLs. */
export interface RemoteStorageOptions {
  /** The storage module (top-level directory) Reflector reads and writes, e.g. `reflector`. */
  module: string;
  /** OAuth `client_id` — the app's origin, identifying Reflector to the provider. */
  clientId: string;
  /** OAuth `redirect_uri` the provider sends the implicit-grant token back to. */
  redirectUri: string;
}

/** What the UI needs to render the current storage location. */
export interface RemoteStorageStatus {
  kind: 'local' | 'remotestorage';
  label: string;
  userAddress: string | null;
}

/** A connect attempt awaiting the OAuth redirect back, keyed by `state`. */
interface PendingConnect {
  userAddress: string;
  href: string;
}

/**
 * A stateless service for connecting a remoteStorage account: it runs
 * WebFinger discovery, hands out the OAuth authorize URL the browser is sent
 * to, completes a connection when the implicit-grant token comes back, and
 * builds the {@link StorageBackend} a {@link SyncEngine} stores its local-first
 * copy in.
 *
 * It holds no per-user connection itself — a completed connection is returned
 * to the caller and persisted with that user's session (see
 * {@link SessionManager}), so different users' remoteStorage accounts stay
 * separate. Only the short-lived `state → attempt` map is kept in memory.
 */
export class RemoteStorageManager {
  private readonly pending = new Map<string, PendingConnect>();

  constructor(
    private readonly options: RemoteStorageOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Discovers `userAddress` and returns the OAuth authorize URL to redirect the
   * browser to, plus the `state` that ties the redirect back to this attempt.
   */
  async beginConnect(
    userAddress: string,
  ): Promise<{ authUrl: string; state: string }> {
    const info = await discover(userAddress, this.fetchImpl);
    const state = randomUUID();
    this.pending.set(state, { userAddress: info.userAddress, href: info.href });

    const url = new URL(info.authUrl);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('scope', `${this.options.module}:rw`);
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('state', state);
    return { authUrl: url.toString(), state };
  }

  /**
   * Completes a connection once the implicit-grant `token` comes back for a
   * `state` from {@link beginConnect}. Returns the connection for the caller to
   * persist against the user's session; this service keeps no copy.
   */
  completeConnect(state: string, token: string): StoredRemoteStorage {
    const pending = this.pending.get(state);
    if (!pending) {
      throw new Error('Unknown or expired remoteStorage connect state.');
    }
    this.pending.delete(state);
    return {
      userAddress: pending.userAddress,
      href: pending.href,
      module: this.options.module,
      token,
      connectedAt: Date.now(),
    };
  }

  /**
   * Connects a remoteStorage account from an already-issued token (e.g. one
   * handed to Reflector via a `#remotestorage=user@host&access_token=...` URL
   * fragment), skipping the OAuth redirect. Discovers `userAddress` and
   * verifies the token actually authorizes access before returning the
   * connection; throws if discovery fails or the token is rejected.
   */
  async connectWithToken(
    userAddress: string,
    token: string,
  ): Promise<StoredRemoteStorage> {
    const info = await discover(userAddress, this.fetchImpl);
    const base = `${info.href}/${this.options.module}`;
    // A folder listing 404s for a module Reflector hasn't written to yet, but
    // still fails on an invalid/unauthorized token (401/403), so it doubles
    // as a cheap way to confirm the token actually works.
    await listFolder(this.authorizedFetch(token), `${base}/`);
    return {
      userAddress: info.userAddress,
      href: info.href,
      module: this.options.module,
      token,
      connectedAt: Date.now(),
    };
  }

  /** The storage backend for a connection, or `undefined` when local files. */
  backend(
    connection: StoredRemoteStorage | undefined,
  ): StorageBackend | undefined {
    if (!connection) {
      return undefined;
    }
    const base = `${connection.href}/${connection.module}`;
    return new RemoteStorageBackend(
      base,
      this.authorizedFetch(connection.token),
      connection.userAddress,
    );
  }

  status(connection: StoredRemoteStorage | undefined): RemoteStorageStatus {
    if (!connection) {
      return { kind: 'local', label: 'Local files', userAddress: null };
    }
    return {
      kind: 'remotestorage',
      label: `remoteStorage: ${connection.userAddress}`,
      userAddress: connection.userAddress,
    };
  }

  /** A `fetch` that attaches the account's bearer token to every request. */
  private authorizedFetch(token: string): typeof fetch {
    const fetchImpl = this.fetchImpl;
    const authorized = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fetchImpl(input, { ...init, headers });
    };
    return authorized as typeof fetch;
  }
}
