// @wc-ignore-file
import { ACCESS_CODES, RECONNECT_CODES } from './transport.js';

/**
 * What went wrong in a sync, classified by the integration proxy's refusal
 * code and the HTTP status, never by message text. The transport (`transport.ts`) records one `ProviderFailure`
 * per non-2xx response; the controller hands those and the thrown error (if
 * any) to `classifyFailure`, which picks the one state the view shows.
 */

export interface ProviderFailure {
  /** HTTP status; 0 when the relay call itself threw (no answer). */
  status: number;
  method: string;
  /** Provider path, e.g. `/v1/search`. Shown only under "Technical details". */
  path: string;
  /** The `retry-after` header as the relay passed it, if any. */
  retryAfter?: string;
  /** The integration proxy's refusal code (`transport.ts`), if it refused. */
  code?: string;
  at: number;
}

export type FailureState =
  | { kind: 'reauth'; technical: string }
  | { kind: 'rate-limited'; retryAt: number; technical: string }
  | { kind: 'failed'; title: string; message: string; technical: string };

/** When no usable `retry-after` came with a 429. */
export const DEFAULT_RETRY_MS = 60_000;

/**
 * `retry-after` is either delay-seconds or an HTTP date (RFC 9110 §10.2.3).
 * Returns the absolute time to retry at, or `undefined` when unusable.
 */
export function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return now + Number(text) * 1000;
  const at = Date.parse(text);

  return Number.isFinite(at) ? Math.max(at, now) : undefined;
}

const technical = (
  failures: readonly ProviderFailure[],
  error: unknown,
): string =>
  [
    ...failures.map(
      f =>
        `${new Date(f.at).toISOString()} ${f.method} ${f.path} → ${f.status}` +
        (f.code ? ` ${f.code}` : '') +
        (f.retryAfter ? ` (retry-after: ${f.retryAfter})` : ''),
    ),
    ...(error === undefined
      ? []
      : [error instanceof Error ? error.message : String(error)]),
  ].join('\n');

/**
 * `error` is what the sync threw, or `undefined` when it finished (possibly
 * with partial-read warnings). Returns `undefined` when there is nothing to
 * show beyond the sync record's own warnings.
 *
 * - A proxy refusal whose code means the connection is gone or no longer
 *   this app's (`RECONNECT_CODES`): reauth, even if the sync finished.
 * - A proxy refusal for access (`unauthorized`, `forbidden`) on a failed
 *   sync: `failed`, as an access problem; reconnecting does not fix it.
 * - Any other proxy refusal on a failed sync: `failed`.
 * - Any 401 from Notion: its grant to the integration is gone: reauth.
 * - A failed sync with a 403: Notion refuses the integration: reauth.
 * - A failed sync with a 429: rate-limited until `retry-after`.
 * - Anything else that failed: `failed`, with the cause in plain words.
 *
 * A sync that finished despite a 403 or 429 on one request is not a failure:
 * its record lists what was not read.
 */
export function classifyFailure(
  failures: readonly ProviderFailure[],
  error: unknown,
  now: number,
): FailureState | undefined {
  const details = technical(failures, error);
  if (failures.some(f => f.code && RECONNECT_CODES.includes(f.code)))
    return { kind: 'reauth', technical: details };
  const refused = failures.find(f => f.code);

  if (refused) {
    if (error === undefined) return undefined;

    return ACCESS_CODES.includes(refused.code!)
      ? {
          kind: 'failed',
          title: 'Atomic isn’t allowed to read this',
          message:
            'The integration relay refused access to this Notion connection for this app. Reconnecting does not change that; ask the person who manages the connection.',
          technical: details,
        }
      : {
          kind: 'failed',
          title: 'The integration relay refused the request',
          message:
            'The relay did not accept this app’s request. This is usually temporary; try again.',
          technical: details,
        };
  }

  if (failures.some(f => f.status === 401))
    return { kind: 'reauth', technical: details };
  if (error === undefined) return undefined;
  if (failures.some(f => f.status === 403))
    return { kind: 'reauth', technical: details };
  const limited = failures.filter(f => f.status === 429);

  if (limited.length) {
    const last = limited[limited.length - 1]!;

    return {
      kind: 'rate-limited',
      retryAt:
        parseRetryAfter(last.retryAfter, now) ?? now + DEFAULT_RETRY_MS,
      technical: details,
    };
  }

  const server = failures.find(f => f.status >= 500);
  if (server)
    return {
      kind: 'failed',
      title: 'Notion didn’t answer properly',
      message: `Notion, or the integration relay in front of it, answered with an error (${server.status}). This is usually temporary.`,
      technical: details,
    };
  if (failures.some(f => f.status === 0))
    return {
      kind: 'failed',
      title: 'Atomic couldn’t reach Notion',
      message: 'The integration relay did not answer.',
      technical: details,
    };
  if (!failures.length)
    return {
      kind: 'failed',
      title: 'The import stopped',
      message:
        'Notion answered, but saving the rows in Atomic failed part-way. Rows saved before that are kept.',
      technical: details,
    };

  return {
    kind: 'failed',
    title: 'The sync stopped',
    message: `Notion refused a request (${failures[0]!.status}).`,
    technical: details,
  };
}
