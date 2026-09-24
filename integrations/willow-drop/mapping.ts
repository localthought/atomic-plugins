// @wc-ignore-file
/** Pure helpers that turn decoded drop entries into row values. No `ctx`. */
import type { DropEntry } from './drop.js';
import { base64, utf8Text, type Path } from './encoding.js';
import type { Shortname } from './schema.js';

/** Payloads up to this many bytes are stored on the row. */
export const MAX_STORED_PAYLOAD = 65536;

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** `/a/b%2fc`: willow25's path notation, bytes outside unreserved escaped. */
export function displayPath(path: Path): string {
  return (
    '/' +
    path
      .map(component =>
        Array.from(component, b => {
          const char = String.fromCharCode(b);

          return b < 0x80 && UNRESERVED.test(char)
            ? char
            : '%' + b.toString(16).padStart(2, '0');
        }).join(''),
      )
      .join('/')
  );
}

/** J2000 (2000-01-01 12:00:00 TT = 11:59:27.816 TAI) as a TAI clock reading,
 * in microseconds since 1970-01-01 00:00 on that same clock. */
const J2000_TAI_US = 946_727_967_816_000n;
/** TAI − UTC from each UTC instant on, in seconds (IERS Bulletin C). */
const LEAP_SECONDS: Array<[bigint, bigint]> = [
  [1483228800_000_000n, 37n], // 2017-01-01
  [1435708800_000_000n, 36n], // 2015-07-01
  [1341100800_000_000n, 35n], // 2012-07-01
  [1230768000_000_000n, 34n], // 2009-01-01
  [1136073600_000_000n, 33n], // 2006-01-01
  [0n, 32n], // from 1999-01-01, which covers J2000
];
const YEAR_2100_US = 4102444800_000_000n;

/** The recommended reading of a timestamp, in UTC; undefined after 2099. */
export function utcTime(timestamp: bigint): string | undefined {
  const tai = J2000_TAI_US + timestamp;
  const [, offset] = LEAP_SECONDS.find(
    ([start, seconds]) => tai - seconds * 1_000_000n >= start,
  )!;
  const utc = tai - offset * 1_000_000n;
  if (utc >= YEAR_2100_US) return undefined;
  const iso = new Date(Number(utc / 1000n)).toISOString();

  return iso.replace('Z', (utc % 1000n).toString().padStart(3, '0') + 'Z');
}

const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];

  return a.length - b.length;
};

export interface Version {
  timestamp: bigint;
  payloadDigest: Uint8Array;
  payloadLength: bigint;
}

/** The data model's "newer than": timestamp, then digest, then length. */
export function newer(a: Version, b: Version): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp;
  const digest = compareBytes(a.payloadDigest, b.payloadDigest);
  if (digest !== 0) return digest > 0;

  return a.payloadLength > b.payloadLength;
}

const sameKeySpace = (a: DropEntry, b: DropEntry) =>
  compareBytes(a.namespace, b.namespace) === 0 &&
  compareBytes(a.subspace, b.subspace) === 0;

const isPrefix = (prefix: Path, path: Path) =>
  prefix.length <= path.length &&
  prefix.every((component, i) => compareBytes(component, path[i]) === 0);

/**
 * The entries a Willow store would keep after joining them: an entry is
 * dropped when a newer entry of the same namespace and subspace has its path
 * or a prefix of it (prefix pruning).
 */
export function prune(entries: DropEntry[]): {
  kept: DropEntry[];
  pruned: number;
} {
  const kept = entries.filter(
    entry =>
      !entries.some(
        other =>
          other !== entry &&
          sameKeySpace(other, entry) &&
          isPrefix(other.path, entry.path) &&
          newer(other, entry),
      ),
  );

  return { kept, pruned: entries.length - kept.length };
}

/** The store key, as the importer's source identity. */
export const sourceId = (entry: DropEntry) =>
  JSON.stringify([
    'willow25',
    hex(entry.namespace),
    hex(entry.subspace),
    entry.path.map(hex),
  ]);

/**
 * Row values by shortname; the plugin maps shortnames to property URLs. Every
 * field is written on every import, so a newer entry never leaves an older
 * payload behind (importRecords sets values; it never removes them).
 */
export function rowValues(entry: DropEntry): Record<Shortname, string> {
  const { payload } = entry;
  const stored = payload !== undefined && payload.length <= MAX_STORED_PAYLOAD;
  const text = stored ? utf8Text(payload) : undefined;

  return {
    'willow-namespace': hex(entry.namespace),
    'willow-subspace': hex(entry.subspace),
    'willow-path': displayPath(entry.path),
    'willow-timestamp': entry.timestamp.toString(),
    'willow-time': utcTime(entry.timestamp) ?? '',
    'willow-payload-length': entry.payloadLength.toString(),
    'willow-payload-digest': hex(entry.payloadDigest),
    'willow-payload-status': stored
      ? 'stored'
      : payload
        ? 'too-large'
        : 'not-in-drop',
    'willow-payload': text ?? '',
    'willow-payload-base64':
      stored && text === undefined ? base64(payload) : '',
    'willow-capability': entry.capability.kind,
    'willow-source-id': sourceId(entry),
  };
}
