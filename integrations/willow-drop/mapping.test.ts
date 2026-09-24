// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { decodeDrop } from './drop';
import { bytes, drop, expected } from './fixtures';
import { base64 } from './encoding';
import { displayPath, prune, rowValues, utcTime } from './mapping';

describe('utcTime: the data model’s recommended reading', () => {
  it('reads J2000 as 2000-01-01 12:00 TT, which is 11:58:55.816 UTC', () => {
    expect(utcTime(0n)).toBe('2000-01-01T11:58:55.816000Z');
  });

  it('applies the leap seconds up to 2017 and keeps microseconds', () => {
    expect(utcTime(843_480_069_184_000n)).toBe('2026-09-24T00:00:00.000000Z');
    expect(utcTime(843_480_069_184_007n)).toBe('2026-09-24T00:00:00.000007Z');
    // One second before 2017-01-01 (TAI − UTC was 36 s) and just after (37 s).
    const newYear2017 =
      1_483_228_800_000_000n - 946_727_967_816_000n + 37_000_000n;
    expect(utcTime(newYear2017)).toBe('2017-01-01T00:00:00.000000Z');
    expect(utcTime(newYear2017 - 2_000_000n)).toBe(
      '2016-12-31T23:59:59.000000Z',
    );
  });

  it('is empty after 2099 rather than guessing future leap seconds', () => {
    expect(utcTime(2n ** 64n - 1n)).toBeUndefined();
  });

  it('differs from willow25 0.7.9’s hifitime reading by 86 432.184 s', () => {
    const [first] = expected.drops.communal;
    const ours = Date.parse(utcTime(BigInt(first.timestamp))!);
    expect(Number(first.willow25UnixMillis) - ours).toBe(86_432_184);
  });
});

describe('row values', () => {
  it('writes willow25’s path notation', () => {
    for (const name of Object.keys(expected.drops).filter(
      n => n !== 'delegated',
    ))
      decodeDrop(drop(name)).forEach((entry, i) =>
        expect(displayPath(entry.path)).toBe(
          expected.drops[name][i].pathDisplay,
        ),
      );
    expect(displayPath([])).toBe('/');
    expect(
      displayPath([bytes('a b'), bytes('x/y'), new Uint8Array([0xff])]),
    ).toBe('/a%20b/x%2fy/%ff');
  });

  it('base64-encodes like Buffer does', () => {
    for (const length of [0, 1, 2, 3, 4, 256]) {
      const data = new Uint8Array(length).map((_, i) => (i * 37) & 0xff);
      expect(base64(data)).toBe(Buffer.from(data).toString('base64'));
    }
  });

  it('stores text, binary and absent payloads with a status', () => {
    const entries = decodeDrop(drop('communal'));
    const byPath = Object.fromEntries(
      entries.map(entry => [displayPath(entry.path), rowValues(entry)]),
    );
    expect(byPath['/notes/hello.txt']).toMatchObject({
      'willow-payload': 'Hello from Willow\n',
      'willow-payload-base64': '',
      'willow-payload-status': 'stored',
      'willow-timestamp': '843480069184000',
      'willow-time': '2026-09-24T00:00:00.000000Z',
      'willow-capability': 'communal',
    });
    expect(byPath['/blog/2026/first-post']['willow-payload']).toBe('Grüße ✓');
    expect(byPath['/blog/empty']).toMatchObject({
      'willow-payload': '',
      'willow-payload-status': 'stored',
      'willow-payload-length': '0',
    });
    expect(byPath['/photos/pixel.bin']).toMatchObject({
      'willow-payload': '',
      'willow-payload-status': 'stored',
    });
    expect(
      Buffer.from(
        byPath['/photos/pixel.bin']['willow-payload-base64'],
        'base64',
      ),
    ).toHaveLength(256);
    expect(byPath['/metadata-only']).toMatchObject({
      'willow-payload': '',
      'willow-payload-base64': '',
      'willow-payload-status': 'not-in-drop',
      'willow-payload-length': '5',
    });
  });
});

describe('prune: what a Willow store keeps', () => {
  it('drops an entry overwritten by a newer entry at a path prefix', () => {
    const { kept, pruned } = prune(decodeDrop(drop('pruning')));
    expect(pruned).toBe(1);
    expect(kept.map(entry => displayPath(entry.path))).toEqual([
      '/old',
      '/old/newer',
    ]);
  });

  it('keeps entries of other subspaces and namespaces', () => {
    const entries = decodeDrop(drop('communal'));
    expect(prune(entries).kept).toHaveLength(entries.length);
  });
});
