// @wc-ignore-file
/**
 * WILLIAM3, the Bab hash instantiation Willow'25 uses for payload digests
 * (https://bab-hash.org/spec, section 2.3.2). It is BLAKE3 with three changes:
 * different IV constants, a chunk counter that is always 0, and parent nodes
 * whose counter is the byte length of the subtree they cover. Chunks are 1024
 * bytes and digests 32 bytes, as in BLAKE3.
 *
 * Only the unkeyed, whole-payload digest is implemented: enough to check a
 * payload a drop carries in full. Verifiable slice streams (Bab section 3) are
 * not, so drops with partial payload slices are refused in drop.ts.
 *
 * Ported from bab_rs 0.8.1 (`william3/basics.rs`, `william3/portable.rs`,
 * `william3.rs`); the tree shape follows `generic/hasher.rs`.
 */

export const CHUNK_SIZE = 1024;
const BLOCK_LEN = 64;

const IV = new Uint32Array([
  0xc88f633b, 0x4168fbf2, 0x6ba32583, 0xb0ff1847, 0xac57e47d, 0xa8931330,
  0x796a4645, 0x6b28a3ee,
]);

const MSG_SCHEDULE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
  [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
  [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
  [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
  [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
  [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
];

const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(
  s: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  y: number,
) {
  s[a] = (s[a] + s[b] + x) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + y) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 7);
}

/** The BLAKE3 compression function, writing the new chaining value into `cv`. */
function compress(
  cv: Uint32Array,
  block: Uint8Array,
  blockLen: number,
  counter: bigint,
  flags: number,
) {
  const m = new Uint32Array(16);

  for (let i = 0; i < 16; i++)
    m[i] =
      (block[i * 4] |
        (block[i * 4 + 1] << 8) |
        (block[i * 4 + 2] << 16) |
        (block[i * 4 + 3] << 24)) >>>
      0;

  const s = new Uint32Array([
    ...cv,
    IV[0],
    IV[1],
    IV[2],
    IV[3],
    Number(counter & 0xffffffffn),
    Number((counter >> 32n) & 0xffffffffn),
    blockLen,
    flags,
  ]);

  for (const schedule of MSG_SCHEDULE) {
    g(s, 0, 4, 8, 12, m[schedule[0]], m[schedule[1]]);
    g(s, 1, 5, 9, 13, m[schedule[2]], m[schedule[3]]);
    g(s, 2, 6, 10, 14, m[schedule[4]], m[schedule[5]]);
    g(s, 3, 7, 11, 15, m[schedule[6]], m[schedule[7]]);
    g(s, 0, 5, 10, 15, m[schedule[8]], m[schedule[9]]);
    g(s, 1, 6, 11, 12, m[schedule[10]], m[schedule[11]]);
    g(s, 2, 7, 8, 13, m[schedule[12]], m[schedule[13]]);
    g(s, 3, 4, 9, 14, m[schedule[14]], m[schedule[15]]);
  }

  for (let i = 0; i < 8; i++) cv[i] = (s[i] ^ s[i + 8]) >>> 0;
}

/** bab_rs `hash1`: absorb `input` block by block into one chaining value. */
function hash1(
  input: Uint8Array,
  counter: bigint,
  flags: number,
  flagsStart: number,
  flagsEnd: number,
): Uint8Array {
  const cv = new Uint32Array(IV);
  let blockFlags = flags | flagsStart;

  if (input.length === 0) {
    compress(cv, new Uint8Array(BLOCK_LEN), 0, counter, blockFlags | flagsEnd);
  } else {
    for (let offset = 0; offset < input.length; offset += BLOCK_LEN) {
      const rest = input.length - offset;
      const block = new Uint8Array(BLOCK_LEN);
      block.set(input.subarray(offset, offset + Math.min(rest, BLOCK_LEN)));
      if (rest <= BLOCK_LEN) blockFlags |= flagsEnd;
      compress(cv, block, Math.min(rest, BLOCK_LEN), counter, blockFlags);
      blockFlags = flags;
    }
  }

  const out = new Uint8Array(32);

  for (let i = 0; i < 8; i++) {
    out[i * 4] = cv[i] & 0xff;
    out[i * 4 + 1] = (cv[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (cv[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (cv[i] >>> 24) & 0xff;
  }

  return out;
}

const hashChunk = (chunk: Uint8Array, isRoot: boolean) =>
  hash1(chunk, 0n, 0, CHUNK_START, CHUNK_END | (isRoot ? ROOT : 0));

function hashInner(
  left: Uint8Array,
  right: Uint8Array,
  length: number,
  isRoot: boolean,
) {
  const block = new Uint8Array(BLOCK_LEN);
  block.set(left, 0);
  block.set(right, 32);

  return hash1(block, BigInt(length), PARENT | (isRoot ? ROOT : 0), 0, 0);
}

/** Label of the subtree over `bytes`, which holds `chunks` chunks. */
function label(bytes: Uint8Array, chunks: number, isRoot: boolean): Uint8Array {
  if (chunks <= 1) return hashChunk(bytes, isRoot);
  // Left subtrees are complete: the largest power of two below `chunks`.
  let left = 1;
  while (left * 2 < chunks) left *= 2;
  const split = left * CHUNK_SIZE;

  return hashInner(
    label(bytes.subarray(0, split), left, false),
    label(bytes.subarray(split), chunks - left, false),
    bytes.length,
    isRoot,
  );
}

/** The WILLIAM3 digest of `bytes`: 32 bytes. */
export function william3(bytes: Uint8Array): Uint8Array {
  return label(bytes, Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE)), true);
}
