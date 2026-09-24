// @wc-ignore-file
/**
 * Getting a drop's bytes back from the text the host hands over.
 *
 * A drop is binary, but at the pinned atomic-server a plugin's `accepts` entry
 * can only be read `as: "text"`: the browser decodes the file as UTF-8 when it
 * is valid UTF-8 (`TextDecoder('utf-8', { fatal: true })`), and as
 * windows-1252 otherwise (atomic-server `FileImport.tsx`). Both decodings can
 * be undone:
 *
 * - UTF-8: re-encoding the text as UTF-8 gives the file's bytes. A leading
 *   byte-order mark would be lost, but a drop never starts with 0xEF (its
 *   first byte is 0x00 or 0b01xxxxxx).
 * - windows-1252: the WHATWG decoder maps every byte to a distinct character
 *   (0x81, 0x8D, 0x8F, 0x90 and 0x9D to U+0081 etc.), so mapping back is exact.
 *   That decoding only happened if the file was not valid UTF-8, so the
 *   candidate is dropped when the mapped-back bytes are valid UTF-8.
 *
 * A drop may also be uploaded base64-encoded (whitespace allowed). decode()
 * tries each possible reading and keeps the ones that decode and verify as a
 * drop; two different successful readings are refused as ambiguous.
 */
import { BASE64, DropError, utf8Text } from './encoding.js';

// WHATWG windows-1252, bytes 0x80..0x9F.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030,
  0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e,
  0x178,
];
const FROM_CP1252 = new Map(CP1252_HIGH.map((code, i) => [code, 0x80 + i]));

/** UTF-8 bytes of `text` (no TextEncoder in the sandbox). */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];

  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }

  return new Uint8Array(out);
}

/** The bytes whose windows-1252 decoding is `text`, if there are any. */
export function cp1252Bytes(text: string): Uint8Array | undefined {
  const out = new Uint8Array(text.length);

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte =
      code < 0x80 || (code >= 0xa0 && code <= 0xff)
        ? code
        : FROM_CP1252.get(code);
    if (byte === undefined) return undefined;
    out[i] = byte;
  }

  return out;
}

/** Standard base64 with optional padding and whitespace, or undefined. */
export function base64Bytes(text: string): Uint8Array | undefined {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1)
    return undefined;
  const body = clean.replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0,
    value = 0;

  for (const char of body) {
    value = (value << 6) | BASE64.indexOf(char);
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }

  return new Uint8Array(out);
}

export interface Reading<T> {
  /** How the text was read back into bytes. */
  encoding: 'utf-8' | 'windows-1252' | 'base64';
  bytes: Uint8Array;
  result: T;
}

/**
 * Tries every way the host could have produced `text` from a drop file, and
 * returns the one that `parse` accepts. Throws `parse`'s own error when none
 * does: the base64 reading's if the text looks like base64, else the
 * windows-1252 reading's if the host can have made it, else the UTF-8 one's.
 */
export function readUpload<T>(
  text: string,
  parse: (bytes: Uint8Array) => T,
): Reading<T> {
  const utf8 = utf8Bytes(text);
  const cp1252 = cp1252Bytes(text);
  const base64 = base64Bytes(text);
  const candidates: Array<Pick<Reading<T>, 'encoding' | 'bytes'>> = [
    { encoding: 'utf-8', bytes: utf8 },
  ];
  if (cp1252 && utf8Text(cp1252) === undefined)
    candidates.push({ encoding: 'windows-1252', bytes: cp1252 });
  if (base64) candidates.push({ encoding: 'base64', bytes: base64 });

  const found: Reading<T>[] = [];
  const errors = new Map<string, unknown>();

  for (const candidate of candidates) {
    try {
      found.push({ ...candidate, result: parse(candidate.bytes) });
    } catch (error) {
      errors.set(candidate.encoding, error);
    }
  }

  const distinct = found.filter(
    (reading, i) =>
      !found
        .slice(0, i)
        .some(
          other =>
            other.bytes.length === reading.bytes.length &&
            other.bytes.every((b, k) => b === reading.bytes[k]),
        ),
  );
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1)
    throw new DropError(
      `This file reads as a valid drop in more than one way (${distinct.map(r => r.encoding).join(', ')}); upload it base64-encoded`,
    );
  // Report the reading the host most likely made.
  throw errors.get(
    base64 ? 'base64' : errors.has('windows-1252') ? 'windows-1252' : 'utf-8',
  );
}
