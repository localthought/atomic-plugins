import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  compact,
  hex,
  unhex,
  utf8,
  U64_MAX,
  encodePath,
  decodePath,
  encodeEntry,
  decodeEntry,
  encodeRelativeEntry,
  decodeRelativeEntry,
} from './codec.mjs';
const vectors = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL('./fixtures/upstream-codecs.json.gz', import.meta.url),
    ),
  ),
);
for (const [type, cases] of Object.entries(vectors.suites))
  test('official Willow vectors: ' + type + ' (' + cases.length + ')', () => {
    for (const vector of cases) {
      const input = new Uint8Array(Buffer.from(vector.bytes, 'base64'));
      const isEntry = type.toLowerCase().includes('entry'),
        canonical = type.startsWith('encode_');

      const decode = () => {
        const value = isEntry
          ? decodeEntry(input, { canonical })
          : decodePath(input);
        const encoded = isEntry ? encodeEntry(value) : encodePath(value);
        if (canonical && !Buffer.from(encoded).equals(Buffer.from(input)))
          throw Error('Noncanonical');
        if (vector.canonical)
          assert.equal(
            Buffer.from(encoded).toString('base64'),
            vector.canonical,
            vector.id,
          );

        return value;
      };

      if (vector.kind === 'yay') assert.doesNotThrow(decode, vector.id);
      else assert.throws(decode, undefined, vector.id);
    }
  });
const entry = (override = {}) => ({
  namespace: new Uint8Array(32).fill(1),
  subspace: new Uint8Array(32).fill(2),
  path: [utf8('a'), utf8('b')],
  timestamp: 1n,
  payloadLength: 3n,
  payloadDigest: new Uint8Array(32).fill(4),
  ...override,
});
test('canonical compact integers preserve every U64 boundary', () => {
  for (const [value, expected] of [
    [0n, '00'],
    [251n, 'fb'],
    [252n, 'fcfc'],
    [255n, 'fcff'],
    [256n, 'fd0100'],
    [65536n, 'fe00010000'],
    [U64_MAX, 'ffffffffffffffffff'],
  ])
    assert.equal(hex(compact(value)), expected);
  for (const value of [-1n, U64_MAX + 1n, 2, NaN])
    assert.throws(() => compact(value));
});
test('binary paths retain empty components, slashes and non-UTF8 octets', () => {
  const path = [
    new Uint8Array(),
    new Uint8Array([0, 47, 255]),
    new Uint8Array(),
  ];
  assert.deepEqual(decodePath(encodePath(path)), path);
  assert.deepEqual(
    decodePath(
      encodePath(Array.from({ length: 4096 }, () => new Uint8Array())),
    ),
    Array.from({ length: 4096 }, () => new Uint8Array()),
  );
  assert.throws(() => encodePath([new Uint8Array(4097)]));
  assert.throws(() => decodePath(new Uint8Array([0x10])));
});
test('relative Entry normative fields: shared identity, positive time delta, compact payload and reused prefix', () => {
  const previous = entry(),
    next = entry({
      timestamp: 5n,
      path: [utf8('a'), utf8('c')],
      payloadLength: 3n,
    });
  // 0x23: same IDs, positive delta, one-byte delta, inline length=3.
  const expected = '2304011163' + '04'.repeat(32);
  assert.equal(hex(encodeRelativeEntry(next, previous)), expected);
  assert.deepEqual(decodeRelativeEntry(unhex(expected), previous), next);
});
test('relative Entry roundtrips changed identities, full U64 and longer path prefixes', () => {
  for (const previous of [
    entry({ timestamp: 0n }),
    entry({ timestamp: U64_MAX, path: [] }),
  ])
    for (const next of [
      entry(),
      entry({ timestamp: U64_MAX, payloadLength: U64_MAX }),
      entry({
        namespace: new Uint8Array(32),
        subspace: new Uint8Array(32),
        path: [new Uint8Array(4096)],
      }),
    ])
      assert.deepEqual(
        decodeRelativeEntry(encodeRelativeEntry(next, previous), previous),
        next,
      );
});
test('relative decoders reject truncation, trailing bytes, timestamp underflow and overflow', () => {
  const previous = entry(),
    encoded = encodeRelativeEntry(entry({ timestamp: 3n }), previous);
  for (let length = 0; length < encoded.length; length++)
    assert.throws(() =>
      decodeRelativeEntry(encoded.slice(0, length), previous),
    );
  assert.throws(() =>
    decodeRelativeEntry(Uint8Array.from([...encoded, 0]), previous),
  );
  const forward = Uint8Array.from([0x20, 1, 0, 0, ...new Uint8Array(32)]);
  assert.throws(() =>
    decodeRelativeEntry(forward, entry({ timestamp: U64_MAX })),
  );
  forward[0] = 0;
  assert.throws(() => decodeRelativeEntry(forward, entry({ timestamp: 0n })));
});
test('decoded byte arrays do not alias the reference or input', () => {
  const previous = entry(),
    encoded = encodeRelativeEntry(entry(), previous),
    decoded = decodeRelativeEntry(encoded, previous);
  decoded.namespace[0] = 99;
  decoded.path[0][0] = 99;
  decoded.payloadDigest[0] = 99;
  assert.equal(previous.namespace[0], 1);
  assert.equal(previous.path[0][0], 97);
  assert.equal(encoded[encoded.length - 1], 4);
});
