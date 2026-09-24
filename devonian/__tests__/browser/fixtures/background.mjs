// Browser smoke driver for `devonian/background`; see root.mjs.
import { BackgroundSync, processLocks } from 'devonian/background';

globalThis.__result = (async () => {
  const data = new Map();
  let runs = 0;
  const sync = new BackgroundSync({
    name: 'browser',
    intervalMs: 60_000,
    store: {
      get: async (k) => data.get(k),
      set: async (k, v) => {
        data.set(k, v);
      },
    },
    locks: processLocks(),
    run: async () => {
      runs++;
    },
  });
  const { outcome } = await sync.syncNow();
  return { runs, outcome, stored: data.size > 0 };
})();
