// @wc-ignore-file
import { LOOKBACK_OPTIONS, type LookbackDays } from '../localthought.js';
import type { Schema } from './schema.js';
import type { JSONValue } from './store.js';

/**
 * What the App resource holds about its Clockify setup. Public ids and a
 * window, no secret, and no connection id either: the host page owns the
 * connection and lists it with `store.proxy.connections()`.
 */
export interface Settings {
  workspaceId: string;
  userId: string;
  lookbackDays: LookbackDays;
}

export type SettingsResult =
  | { ok: true; settings: Settings }
  | { ok: false; missing: (keyof Settings)[]; partial: Partial<Settings> };

const text = (value: JSONValue) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const lookback = (value: JSONValue): LookbackDays | undefined =>
  LOOKBACK_OPTIONS.find(days => String(days) === String(value));

/**
 * Reads the settings off the App resource. Unlike a connection, every field
 * is required: an unsupported look-back is reported as missing rather than
 * silently widened, and nothing is fetched until the person has chosen.
 */
export function readSettings(
  get: (property: string) => JSONValue,
  schema: Pick<Schema, 'settings'>,
): SettingsResult {
  const read = (subject: string | undefined) =>
    subject ? get(subject) : undefined;
  const workspaceId = text(read(schema.settings.workspaceId));
  const userId = text(read(schema.settings.userId));
  const lookbackDays = lookback(read(schema.settings.lookbackDays));

  if (workspaceId && userId && lookbackDays)
    return { ok: true, settings: { workspaceId, userId, lookbackDays } };

  return {
    ok: false,
    missing: [
      ...(workspaceId ? [] : (['workspaceId'] as const)),
      ...(userId ? [] : (['userId'] as const)),
      ...(lookbackDays ? [] : (['lookbackDays'] as const)),
    ],
    partial: {
      ...(workspaceId ? { workspaceId } : {}),
      ...(userId ? { userId } : {}),
      ...(lookbackDays ? { lookbackDays } : {}),
    },
  };
}
