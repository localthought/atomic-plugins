export {
  BackgroundSync,
  defaultLocks,
  processLocks,
  webLocks,
  type BackgroundSyncOptions,
  type BackgroundSyncState,
  type SyncLocks,
  type SyncStateStore,
  type TickOutcome,
  type TickResult,
  type WebLockManagerLike,
} from './BackgroundSync.js';
export {
  handleBackgroundSyncEvent,
  registerBackgroundSync,
  type BackgroundSyncEventLike,
  type BackgroundSyncRegistration,
  type BackgroundSyncRegistrationLike,
} from './serviceWorker.js';
