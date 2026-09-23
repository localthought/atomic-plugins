import { BackgroundSync } from 'devonian';

/**
 * Failures that retrying cannot fix: the Bridge, the proxy transport or the
 * Atomic port refuse to guess, so a person must look before the next pass.
 * Everything else (network, rate limits, an Atomic drive still syncing, an
 * unacknowledged save) is transient and backs off.
 */
export const permanentSyncErrors = [
  /^Conflict/, // same-field conflict, or during a saved operation
  /^Concurrent edit after write/,
  /^Missing (local|remote) record/,
  /^State belongs to another connection/,
  /^Duplicate /, // duplicate external or Atomic creation identity
  /^Recovered Atomic create was edited/,
  /^Atomic write rejected/,
  /^Uncertain GitHub write/,
  /^Operation identity reused/,
  // The rotating proxy code is gone or revoked: reconnect first.
  /^Connect to the proxy or supply a fresh connection code/,
  /^Proxy did not expose X-Connection-Code/,
  /^GitHub \S+ returned 401$/,
];

export const isPermanentSyncError = error =>
  permanentSyncErrors.some(pattern =>
    pattern.test(error instanceof Error ? error.message : String(error)),
  );

/**
 * A persisted background schedule for one GitHub issues connection.
 *
 * `openBridge` must build a new Bridge from the persisted snapshot on every
 * call: a tab, a service worker or another host may have synced since the
 * last pass, and a cached Bridge would reconcile from a stale checkpoint.
 * Every pass runs under the schedule's lease (`withLock`); a host must put
 * any other spend of the same connection's rotating proxy code under it too.
 */
export function createBackgroundSync({
  openBridge,
  name = 'github-issues',
  ...options
}) {
  if (typeof openBridge !== 'function')
    throw new Error('openBridge is required');

  return new BackgroundSync({
    isPermanent: isPermanentSyncError,
    ...options,
    name,
    run: async () => {
      const bridge = await openBridge();
      await bridge.sync();
    },
  });
}
