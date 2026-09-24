// @wc-ignore-file
/**
 * The byte-level building blocks of Willow's encodings
 * (https://willowprotocol.org/specs/encodings/): compact U64s and paths, with
 * Willow'25's path limits. Ported from the compact_u64 0.6.0 crate and
 * willow25 0.7.9 `paths/codec.rs`. U64 values are bigints, never numbers.
 */

/** Willow'25's maximum component length, component count and path length. */
export const MCL = 4096;
export const MCC = 4096;
export const MPL = 4096;

/** A malformed or unsupported drop. `entry` is the zero-based entry index. */
export class DropError extends Error {
  constructor(
    message: string,
    public readonly entry?: number,
  ) {
    super(entry === undefined ? message : `Entry ${entry + 1}: ${message}`);
  }
}

export class Reader {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining() {
    return this.bytes.length - this.offset;
  }

  peek(): number {
    if (this.offset >= this.bytes.length)
      throw new DropError('the drop ends in the middle of an entry');

    return this.bytes[this.offset];
  }

  byte(): number {
    const value = this.peek();
    this.offset++;

    return value;
  }

  take(count: number): Uint8Array {
    if (count > this.remaining)
      throw new DropError('the drop ends in the middle of an entry');
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;

    return out;
  }

  /** A compact U64 whose `width`-bit tag sits at bit `offset` of `tagByte`
   * (bit 0 is the most significant). */
  cu64(tagByte: number, width: number, offset: number): bigint {
    const max = (1 << width) - 1;
    const tag = (tagByte >> (8 - offset - width)) & max;
    const bytes = [8, 4, 2, 1][max - tag];
    if (bytes === undefined) return BigInt(tag);
    let value = 0n;
    for (const b of this.take(bytes)) value = (value << 8n) | BigInt(b);

    return value;
  }

  /** A compact U64 preceded by its own 8-bit tag byte. */
  cu64Standalone(): bigint {
    return this.cu64(this.byte(), 8, 0);
  }
}

/** A small bigint as a number, or a DropError when it cannot be one here. */
export function small(value: bigint, limit: number, what: string): number {
  if (value > BigInt(limit)) throw new DropError(`${what} exceeds ${limit}`);

  return Number(value);
}

export type Path = Uint8Array[];

function decodeComponents(
  reader: Reader,
  prefix: Path,
  count: number,
  totalLength: number,
): Path {
  const path = [...prefix];
  let accumulated = prefix.reduce((sum, c) => sum + c.length, 0);

  if (count === 0) {
    if (totalLength > accumulated)
      throw new DropError('a path claims more bytes than its components hold');

    return path;
  }

  for (let i = 1; i < count; i++) {
    const length = small(reader.cu64Standalone(), MCL, 'a path component');
    accumulated += length;
    path.push(reader.take(length));
  }

  const last = totalLength - accumulated;
  if (last < 0 || last > MCL)
    throw new DropError('a path has an invalid final component length');
  path.push(reader.take(last));

  return path;
}

/** EncodePathRelativePath: a path relative to the previous entry's path. */
export function decodeRelativePath(reader: Reader, previous: Path): Path {
  const prefixCount = small(reader.cu64Standalone(), MCC, 'a path prefix');
  const header = reader.byte();
  const suffixLength = small(reader.cu64(header, 4, 0), MPL, 'a path');
  const suffixCount = small(reader.cu64(header, 4, 4), MCC, 'a path');
  if (prefixCount > previous.length)
    throw new DropError('a path reuses more components than exist');
  const prefix = previous.slice(0, prefixCount);
  const prefixLength = prefix.reduce((sum, c) => sum + c.length, 0);
  if (prefixLength + suffixLength > MPL || prefixCount + suffixCount > MCC)
    throw new DropError('a path exceeds the Willow25 limits');

  return decodeComponents(
    reader,
    prefix,
    suffixCount,
    prefixLength + suffixLength,
  );
}

function tagFor(n: bigint, width: number): number {
  const maxInline = BigInt((1 << width) - 4);
  const max = (1 << width) - 1;
  if (n < maxInline) return Number(n);
  if (n < 256n) return max - 3;
  if (n < 65536n) return max - 2;
  if (n < 4294967296n) return max - 1;

  return max;
}

function cu64Bytes(n: bigint, width: number): number[] {
  const size = [8, 4, 2, 1][(1 << width) - 1 - tagFor(n, width)];
  if (size === undefined) return [];
  const out: number[] = [];
  for (let i = size - 1; i >= 0; i--)
    out.push(Number((n >> BigInt(i * 8)) & 0xffn));

  return out;
}

/** A compact U64 with its own 8-bit tag byte. */
export function encodeCu64Standalone(n: bigint): number[] {
  return [tagFor(n, 8), ...cu64Bytes(n, 8)];
}

/** encode_path: the absolute path encoding, as signatures cover it. */
export function encodePath(path: Path): number[] {
  const length = BigInt(path.reduce((sum, c) => sum + c.length, 0));
  const count = BigInt(path.length);
  const out = [(tagFor(length, 4) << 4) | tagFor(count, 4)];
  out.push(...cu64Bytes(length, 4), ...cu64Bytes(count, 4));
  path.forEach((component, i) => {
    if (i + 1 < path.length)
      out.push(...encodeCu64Standalone(BigInt(component.length)));
    out.push(...component);
  });

  return out;
}

/** UTF-8 text of `bytes`, or undefined when they are not well-formed UTF-8. */
export function utf8Text(bytes: Uint8Array): string | undefined {
  let out = '';

  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let need = 0,
      code = b,
      min = 0;
    if (b >= 0xc2 && b <= 0xdf) [need, code, min] = [1, b & 0x1f, 0x80];
    else if (b >= 0xe0 && b <= 0xef) [need, code, min] = [2, b & 0x0f, 0x800];
    else if (b >= 0xf0 && b <= 0xf4) [need, code, min] = [3, b & 0x07, 0x10000];
    else if (b >= 0x80) return undefined;
    if (i + need >= bytes.length && need > 0) return undefined;

    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) return undefined;
      code = (code << 6) | (c & 0x3f);
    }

    if (
      (need && code < min) ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return undefined;
    out += String.fromCodePoint(code);
    i += need + 1;
  }

  return out;
}

export const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding. */
export function base64(bytes: Uint8Array): string {
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }

  return out;
}
