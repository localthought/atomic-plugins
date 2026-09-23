/**
 * Feature-detected service worker glue for {@link BackgroundSync}.
 *
 * Browser support, as of this writing: Periodic Background Sync
 * (`registration.periodicSync`) and one-shot Background Sync
 * (`registration.sync`) exist only in Chromium-based browsers. Periodic sync
 * additionally needs the site installed as a PWA with the
 * `periodic-background-sync` permission granted, and the browser — not the
 * page — chooses how often it fires (`minInterval` is only a lower bound;
 * expect hours, not minutes). Firefox and Safari offer neither, so there the
 * schedule only advances while a tab is open. None of this gives "every
 * minute with the browser closed"; that needs a non-browser host running the
 * same {@link BackgroundSync} against the same kind of store.
 */
import type { BackgroundSync, TickResult } from './BackgroundSync.js';

/** The subset of `ServiceWorkerRegistration` used here. */
export interface BackgroundSyncRegistrationLike {
  periodicSync?: {
    register(tag: string, options: { minInterval: number }): Promise<void>;
    unregister?(tag: string): Promise<void>;
  };
  sync?: { register(tag: string): Promise<void> };
}

export interface BackgroundSyncRegistration {
  /** A `periodicsync` event with this tag will be delivered (browser's own cadence). */
  periodic: boolean;
  /** A one-shot `sync` event with this tag fires when connectivity allows. */
  oneShot: boolean;
  /** Why an available API refused, e.g. a missing permission. */
  errors: string[];
}

/**
 * Asks the browser to wake the service worker for `tag`. Registers periodic
 * sync where allowed, plus a one-shot sync so a pass missed while offline
 * runs when the connection returns. Never throws for an unsupported or
 * refused API; the result says what was registered.
 */
export async function registerBackgroundSync(
  registration: BackgroundSyncRegistrationLike,
  tag: string,
  minIntervalMs: number,
): Promise<BackgroundSyncRegistration> {
  const result: BackgroundSyncRegistration = {
    periodic: false,
    oneShot: false,
    errors: [],
  };
  const attempt = async (
    kind: 'periodic' | 'oneShot',
    register: () => Promise<void>,
  ): Promise<void> => {
    try {
      await register();
      result[kind] = true;
    } catch (error) {
      result.errors.push(
        `${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const { periodicSync, sync } = registration;
  if (periodicSync)
    await attempt('periodic', () =>
      periodicSync.register(tag, { minInterval: minIntervalMs }),
    );
  if (sync) await attempt('oneShot', () => sync.register(tag));
  return result;
}

/** The subset of a `periodicsync` / `sync` event used here. */
export interface BackgroundSyncEventLike {
  tag: string;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Handles a service worker `periodicsync` or `sync` event for `tag` by
 * running one {@link BackgroundSync.tick}. Returns false for other tags so a
 * worker can chain handlers. The promise passed to `waitUntil` never
 * rejects: the scheduler already records failures and backs off, and a
 * rejection would make the browser add retries of its own on top.
 */
export function handleBackgroundSyncEvent(
  event: BackgroundSyncEventLike,
  sync: Pick<BackgroundSync, 'tick'>,
  tag: string,
  onResult?: (result: TickResult) => void,
): boolean {
  if (event.tag !== tag) return false;
  event.waitUntil(
    sync.tick().then(
      (result) => onResult?.(result),
      (error) => console.error('Background sync tick failed:', error),
    ),
  );
  return true;
}
