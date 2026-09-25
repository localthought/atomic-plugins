// @wc-ignore-file
/**
 * Reads the M1 observation log's mirror for the views, without syncing:
 * on open (before the first sync of this page load) and when the host has
 * no proxy relay (design frame K). Writes nothing.
 */
import { ObservationLog } from './observationLog.js';
import { emptyMirror, type Mirror } from './observations.js';
import { findSchema, type CompleteSchema } from './schema.js';
import type { PluginStore } from './store.js';

export async function readMirror(
  store: PluginStore,
  clock: () => number = Date.now,
): Promise<Mirror> {
  const schema = await findSchema(store);
  const { log, head, observation, snapshot } = schema.log;
  // No log Properties yet: this app never synced.
  if (!log || !head || !observation || !snapshot) return emptyMirror();

  return (await ObservationLog.open(store, schema as CompleteSchema, { clock }))
    .mirror;
}
