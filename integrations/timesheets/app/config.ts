// @wc-ignore-file
import { LOOKBACK_OPTIONS, type LookbackDays } from '../localthought.js';
import { config as props } from './ontology.js';
import type { JSONValue } from './store.js';

/** What the App resource holds about its Clockify connection. No secret. */
export interface ConnectionReference {
  platform: 'clockify';
  connectionId: string;
  workspaceId: string;
  userId: string;
  lookbackDays: LookbackDays;
}

export type ConfigResult =
  | { ok: true; reference: ConnectionReference }
  | { ok: false; missing: string[] };

const text = (value: JSONValue) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Reads the connection reference off the App resource's properties. A
 * missing look-back falls back to 7 days, the same default as
 * `defaultClockifySelection()`; an unsupported one is reported as missing
 * rather than silently widened.
 */
export function readConnectionReference(
  get: (property: string) => JSONValue,
): ConfigResult {
  const connectionId = text(get(props.connectionId));
  const workspaceId = text(get(props.workspaceId));
  const userId = text(get(props.userId));
  const rawLookback = get(props.lookbackDays);
  const lookbackDays =
    rawLookback === undefined || rawLookback === null
      ? 7
      : LOOKBACK_OPTIONS.find(days => String(days) === String(rawLookback));

  const missing = [
    ...(connectionId ? [] : ['connectionId']),
    ...(workspaceId ? [] : ['workspaceId']),
    ...(userId ? [] : ['userId']),
    ...(lookbackDays ? [] : ['lookbackDays']),
  ];

  if (!connectionId || !workspaceId || !userId || !lookbackDays)
    return { ok: false, missing };

  return {
    ok: true,
    reference: {
      platform: 'clockify',
      connectionId,
      workspaceId,
      userId,
      lookbackDays,
    },
  };
}
