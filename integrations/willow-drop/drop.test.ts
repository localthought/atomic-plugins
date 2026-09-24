// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { decodeDrop, type DropEntry } from './drop';
import { DropError, encodePath, Reader, decodeRelativePath } from './encoding';
import { hex } from './mapping';
import { william3 } from './william3';
import { bytes, drop, expected, type Expected } from './fixtures';

const summary = (
  entry: DropEntry,
): Omit<Expected, 'willow25UnixMillis' | 'pathDisplay'> => ({
  namespace: hex(entry.namespace),
  subspace: hex(entry.subspace),
  path: entry.path.map(hex),
  timestamp: entry.timestamp.toString(),
  payloadLength: entry.payloadLength.toString(),
  payloadDigest: hex(entry.payloadDigest),
  capability: entry.capability.kind,
  payload: entry.payload ? hex(entry.payload) : null,
});

describe('WILLIAM3', () => {
  it('matches willow25’s default payload digest for the empty string', () => {
    expect(hex(william3(new Uint8Array()))).toBe(
      '96d34c5478458231e364767952aaea02a31d2203c66f4365692ef91f351068d2',
    );
  });

  it('matches the willow25 EntryBuilder::payload doc example', () => {
    expect(Array.from(william3(bytes('See all the sights!')))).toEqual([
      91, 29, 243, 211, 140, 181, 127, 138, 116, 79, 56, 47, 85, 50, 157, 82,
      55, 192, 253, 122, 72, 250, 70, 43, 56, 116, 99, 53, 188, 85, 83, 234,
    ]);
  });

  it('matches willow25 for every fixture payload, including 2500 bytes over three chunks', () => {
    const payloads = Object.values(expected.drops)
      .flat()
      .filter(entry => entry.payload !== null);
    expect(payloads.some(e => e.payloadLength === '2500')).toBe(true);

    for (const entry of payloads)
      expect(hex(william3(Buffer.from(entry.payload!, 'hex')))).toBe(
        entry.payloadDigest,
      );
  });
});

describe('encodings', () => {
  it('round-trips a relative path', () => {
    const previous = [bytes('notes'), bytes('hello.txt')];
    // prefix count 1, then the suffix "todo.txt": one 8-byte component.
    const reader = new Reader(new Uint8Array([1, 0x81, ...bytes('todo.txt')]));
    expect(decodeRelativePath(reader, previous).map(hex)).toEqual([
      hex(bytes('notes')),
      hex(bytes('todo.txt')),
    ]);
    expect(reader.remaining).toBe(0);
  });

  it('encodes a path the way encode_path does', () => {
    // total length 9 (4-bit tag 9), 2 components (tag 2), first length as a
    // standalone compact U64 (tag byte 4), then the bytes.
    expect(encodePath([bytes('abcd'), bytes('efghi')])).toEqual([
      0x92,
      4,
      ...bytes('abcd'),
      ...bytes('efghi'),
    ]);
  });
});

describe('decodeDrop against drops written by willow25', () => {
  for (const name of ['communal', 'owned', 'pruning', 'empty'])
    it(`decodes and verifies ${name}.drop`, () => {
      expect(decodeDrop(drop(name)).map(summary)).toEqual(
        // The two display fields are checked in mapping.test.ts.
        expected.drops[name].map(
          ({ willow25UnixMillis: _, pathDisplay: __, ...rest }) => rest,
        ),
      );
    });

  it('decodes an entry with a 2500-byte payload and one without a payload', () => {
    const entries = decodeDrop(drop('communal'));
    expect(entries.find(e => e.payloadLength === 2500n)?.payload?.length).toBe(
      2500,
    );
    const metadataOnly = entries.at(-1)!;
    expect(metadataOnly.payloadLength).toBe(5n);
    expect(metadataOnly.payload).toBeUndefined();
  });

  it('refuses a delegated capability instead of guessing', () => {
    expect(() => decodeDrop(drop('delegated'))).toThrow(
      'Entry 1: its write capability carries delegations',
    );
  });
});

describe('decodeDrop refuses tampered drops', () => {
  const replace = (source: Uint8Array, from: string, to: string) => {
    const at = Buffer.from(source).indexOf(from);
    expect(at).toBeGreaterThan(-1);
    const copy = new Uint8Array(source);
    copy.set(bytes(to), at);

    return copy;
  };

  it('a changed path breaks the signature', () => {
    expect(() =>
      decodeDrop(replace(drop('communal'), 'hello.txt', 'hellp.txt')),
    ).toThrow('Entry 1: its authorisation signature does not verify');
  });

  it('a changed payload no longer matches its digest', () => {
    expect(() =>
      decodeDrop(replace(drop('communal'), 'oat milk', 'cow milk')),
    ).toThrow('Entry 2: its payload does not match its digest');
  });

  it('an owned capability with a forged namespace signature', () => {
    const source = drop('owned');
    // Header, namespace, subspace, path (9), timestamp (8), length (2),
    // digest (32), capability header, then carol's key and the namespace's
    // signature over it.
    const copy = new Uint8Array(source);
    copy[1 + 32 + 32 + 9 + 8 + 2 + 32 + 1 + 32] ^= 1;
    expect(() => decodeDrop(copy)).toThrow(
      "Entry 1: its owned capability is not signed by the namespace's key",
    );
  });

  it('a truncated drop', () => {
    const source = drop('communal');
    expect(() => decodeDrop(source.subarray(0, source.length - 1))).toThrow(
      DropError,
    );
    expect(() => decodeDrop(source.subarray(0, 100))).toThrow(
      'the drop ends in the middle',
    );
  });

  it('trailing bytes after the terminating zero', () => {
    expect(() => decodeDrop(new Uint8Array([0, 0]))).toThrow(
      'there are bytes after the end of the drop',
    );
  });

  it('partial payload slices', () => {
    const source = new Uint8Array(drop('owned'));
    source[0] = (source[0] & 0xfc) | 0x02;
    expect(() => decodeDrop(source)).toThrow(
      'Entry 1: it carries a partial payload prefix',
    );
  });
});
