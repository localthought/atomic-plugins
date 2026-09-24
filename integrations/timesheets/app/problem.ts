// @wc-ignore-file
/**
 * A failed sync, as the banners in design #89 §6J need it: what kind of
 * failure it was, when to try again, and the raw detail for bug reports.
 * Pure; the controller attaches one to a failed `SyncOutcome`.
 */
import { ProxyError } from './transport.js';

export type ProblemKind =
  /** 401: the key was deleted or regenerated. */
  | 'reauth'
  /** 403 on time entries: this account cannot read that workspace. */
  | 'forbidden'
  /** 429. */
  | 'rate-limited'
  /** The relay or the proxy could not be reached (no HTTP status). */
  | 'network'
  /** More than the page cap (200 × 50 entries). */
  | 'too-many'
  | 'other';

export interface Problem {
  kind: ProblemKind;
  /** For `rate-limited`: from `retry-after` when relayed, else 60. */
  retryAfterSeconds?: number;
  /** HTTP status and message, or the error text: for the Details disclosure. */
  detail: string;
}

export const DEFAULT_RETRY_SECONDS = 60;

/** `retry-after` as seconds (a number or an HTTP date), else undefined. */
export function retryAfterSeconds(
  header: string | undefined,
  now: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);

  return Number.isFinite(at)
    ? Math.max(0, Math.ceil((at - now) / 1000))
    : undefined;
}

const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function classify(error: unknown, now = Date.now()): Problem {
  if (error instanceof ProxyError) {
    const message =
      error.body && typeof error.body === 'object' && 'message' in error.body
        ? ` "${String((error.body as { message: unknown }).message)}"`
        : typeof error.body === 'string' && error.body
          ? ` "${error.body}"`
          : '';
    const detail = `HTTP ${error.status} on GET ${error.path}${message}`;

    if (error.status === 401) return { kind: 'reauth', detail };
    if (error.status === 403) return { kind: 'forbidden', detail };

    if (error.status === 429)
      return {
        kind: 'rate-limited',
        retryAfterSeconds:
          retryAfterSeconds(error.retryAfter, now) ?? DEFAULT_RETRY_SECONDS,
        detail,
      };

    return { kind: 'other', detail };
  }

  const detail = text(error);
  // The integration proxy's own refusal of a connection that is gone or no
  // longer this app's (#54 phase 2, `transport.ts`'s `proxyRefusal`).
  if (/refused this connection/.test(detail)) return { kind: 'reauth', detail };
  if (/returned more than \d+ pages/.test(detail))
    return { kind: 'too-many', detail };

  // What the relay throws instead of answering: the proxy (or the host
  // page's connection to it) was not reachable. The host's exact error
  // text is not specified, so this matches loosely.
  if (error instanceof TypeError || /fetch|network|relay|proxy/i.test(detail))
    return { kind: 'network', detail };

  return { kind: 'other', detail };
}
