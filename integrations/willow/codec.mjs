/** Willow'25 encoding primitives. No authentication or transport is performed.
 * Spec: https://willowprotocol.org/specs/encodings/index.html
 * Parameters: https://willowprotocol.org/specs/willow25/
 */
export const U64_MAX = (1n << 64n) - 1n;
export const PATH_LIMIT = 4096;
export function u64(value) {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX)
    throw Error('Expected unsigned 64-bit bigint');

  return value;
}
export function bytes(value, length) {
  if (
    !(value instanceof Uint8Array) ||
    (length !== undefined && value.length !== length)
  )
    throw Error('Invalid byte sequence length');

  return value;
}
export function hex(value) {
  return Array.from(bytes(value), b => b.toString(16).padStart(2, '0')).join(
    '',
  );
}
export function unhex(value) {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(value))
    throw Error('Invalid hexadecimal bytes');

  return Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16));
}
export function utf8(text) {
  if (typeof text !== 'string') throw Error('Expected text');
  const encoded = encodeURIComponent(text),
    out = [];

  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') {
      out.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(encoded.charCodeAt(i));
  }

  return Uint8Array.from(out);
}

const concat = (...parts) =>
  Uint8Array.from(parts.flatMap(part => Array.from(part)));

export function tag(value, width) {
  u64(value);
  if (!Number.isInteger(width) || width < 2 || width > 8)
    throw Error('Invalid compact integer tag width');
  const first = (1 << width) - 4;
  if (value < BigInt(first)) return Number(value);

  return (
    first +
    (value < 256n ? 0 : value < 65536n ? 1 : value < 4294967296n ? 2 : 3)
  );
}

function trailing(value, width) {
  const extra = tag(value, width) - ((1 << width) - 4);
  if (extra < 0) return [];
  const size = [1, 2, 4, 8][extra],
    out = [];
  for (let i = size - 1; i >= 0; i--)
    out.push(Number((value >> BigInt(i * 8)) & 255n));

  return out;
}

export const compact = value =>
  Uint8Array.from([tag(value, 8), ...trailing(value, 8)]);
class Reader {
  constructor(input) {
    this.input = bytes(input);
    this.at = 0;
  }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.input.length - this.at)
      throw Error('Truncated encoding');
    const result = this.input.slice(this.at, this.at + n);
    this.at += n;

    return result;
  }
  byte() {
    return this.take(1)[0];
  }
  compact(t = this.byte(), width = 8) {
    const extra = t - ((1 << width) - 4);
    if (extra < 0) return BigInt(t);
    let value = 0n;
    for (const b of this.take([1, 2, 4, 8][extra]))
      value = (value << 8n) | BigInt(b);

    return value;
  }
  end() {
    if (this.at !== this.input.length) throw Error('Trailing encoding bytes');
  }
}

export function validatePath(path) {
  if (!Array.isArray(path) || path.length > PATH_LIMIT)
    throw Error('Too many path components');
  let length = 0;

  for (const part of path) {
    if (bytes(part).length > PATH_LIMIT) throw Error('Path component too long');
    length += part.length;
  }

  if (length > PATH_LIMIT) throw Error('Path too long');

  return path;
}
export function encodePath(path) {
  validatePath(path);
  const length = BigInt(path.reduce((n, p) => n + p.length, 0)),
    count = BigInt(path.length);
  const out = [
    (tag(length, 4) << 4) | tag(count, 4),
    ...trailing(length, 4),
    ...trailing(count, 4),
  ];
  path.forEach((part, i) => {
    if (i < path.length - 1) out.push(...compact(BigInt(part.length)));
    out.push(...part);
  });

  return Uint8Array.from(out);
}

function readPath(reader) {
  const header = reader.byte(),
    total = reader.compact(header >>> 4, 4),
    count = reader.compact(header & 15, 4);
  if (total > 4096n || count > 4096n) throw Error('Path limits exceeded');
  if (count === 0n && total !== 0n) throw Error('Empty path claims bytes');
  const path = [];
  let remaining = Number(total);

  for (let i = 0; i < Number(count); i++) {
    const length =
      i === Number(count) - 1 ? BigInt(remaining) : reader.compact();
    if (length > BigInt(remaining))
      throw Error('Component exceeds remaining path bytes');
    path.push(reader.take(Number(length)));
    remaining -= Number(length);
  }

  return path;
}

export function decodePath(input) {
  const reader = new Reader(input),
    path = readPath(reader);
  reader.end();

  return path;
}

const sameBytes = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function pathPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && sameBytes(a[i], b[i])) i++;

  return i;
}

function relativePath(path, previous) {
  validatePath(previous);
  const prefix = pathPrefix(path, previous);

  return concat(compact(BigInt(prefix)), encodePath(path.slice(prefix)));
}

function readRelativePath(reader, previous) {
  const prefix = reader.compact();
  if (prefix > BigInt(previous.length))
    throw Error('Relative path prefix exceeds reference');

  return validatePath([
    ...previous.slice(0, Number(prefix)).map(p => p.slice()),
    ...readPath(reader),
  ]);
}

export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw Error('Invalid Entry');
  bytes(entry.namespace, 32);
  bytes(entry.subspace, 32);
  bytes(entry.payloadDigest, 32);
  validatePath(entry.path);
  u64(entry.timestamp);
  u64(entry.payloadLength);

  return entry;
}
/** Canonical encode_entry: exact bytes covered by a future Meadowcap signature. */
export function encodeEntry(entry) {
  validateEntry(entry);

  return concat(
    entry.namespace,
    entry.subspace,
    encodePath(entry.path),
    compact(entry.timestamp),
    compact(entry.payloadLength),
    entry.payloadDigest,
  );
}
/** Decode the general EncodeEntry relation (nonminimal tags are allowed).
 * canonical=true additionally requires the unique signing representation.
 */
export function decodeEntry(input, { canonical = false } = {}) {
  const reader = new Reader(input),
    entry = {
      namespace: reader.take(32),
      subspace: reader.take(32),
      path: readPath(reader),
      timestamp: reader.compact(),
      payloadLength: reader.compact(),
      payloadDigest: reader.take(32),
    };
  reader.end();
  validateEntry(entry);
  if (canonical && !sameBytes(input, encodeEntry(entry)))
    throw Error('Noncanonical Entry encoding');

  return entry;
}
/** One minimal EncodeEntryRelativeEntry code, used by Willow sync encodings. */
export function encodeRelativeEntry(entry, previous) {
  validateEntry(entry);
  validateEntry(previous);
  const differentNamespace = !sameBytes(entry.namespace, previous.namespace),
    differentSubspace = !sameBytes(entry.subspace, previous.subspace);
  const forward = entry.timestamp > previous.timestamp,
    delta = forward
      ? entry.timestamp - previous.timestamp
      : previous.timestamp - entry.timestamp;
  const header =
    (differentNamespace ? 128 : 0) |
    (differentSubspace ? 64 : 0) |
    (forward ? 32 : 0) |
    (tag(delta, 2) << 3) |
    tag(entry.payloadLength, 3);

  return concat(
    [header],
    differentNamespace ? entry.namespace : [],
    differentSubspace ? entry.subspace : [],
    trailing(delta, 2),
    trailing(entry.payloadLength, 3),
    relativePath(entry.path, previous.path),
    entry.payloadDigest,
  );
}
export function decodeRelativeEntry(input, previous) {
  validateEntry(previous);
  const reader = new Reader(input),
    header = reader.byte();
  const namespace = header & 128 ? reader.take(32) : previous.namespace.slice(),
    subspace = header & 64 ? reader.take(32) : previous.subspace.slice();
  const delta = reader.compact((header >>> 3) & 3, 2),
    payloadLength = reader.compact(header & 7, 3);
  const timestamp =
    header & 32 ? previous.timestamp + delta : previous.timestamp - delta;
  const entry = {
    namespace,
    subspace,
    timestamp,
    payloadLength,
    path: readRelativePath(reader, previous.path),
    payloadDigest: reader.take(32),
  };
  reader.end();

  return validateEntry(entry);
}
