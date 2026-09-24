// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { decodeDrop } from './drop';
import { drop } from './fixtures';
import { base64Bytes, cp1252Bytes, readUpload, utf8Bytes } from './upload';

/** What atomic-server's FileImport.tsx does to a file before `run()` sees it. */
function hostText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

describe('undoing the host’s text decoding', () => {
  it('maps every byte through windows-1252 and back', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(cp1252Bytes(new TextDecoder('windows-1252').decode(all))).toEqual(
      all,
    );
  });

  it('re-encodes UTF-8, including astral characters', () => {
    const text = 'a é ✓ 𝄞';
    expect(utf8Bytes(text)).toEqual(new Uint8Array(Buffer.from(text)));
  });

  it('decodes padded and unpadded base64 with whitespace', () => {
    const data = new Uint8Array([0, 1, 2, 250, 251]);
    const encoded = Buffer.from(data).toString('base64');
    expect(base64Bytes(encoded)).toEqual(data);
    expect(base64Bytes(encoded.replace(/=/g, ''))).toEqual(data);
    expect(base64Bytes(encoded.slice(0, 4) + '\n' + encoded.slice(4))).toEqual(
      data,
    );
    expect(base64Bytes('not base64!')).toBeUndefined();
  });
});

describe('readUpload recovers each fixture drop', () => {
  for (const name of ['communal', 'owned', 'pruning', 'empty']) {
    const bytes = drop(name);

    it(`${name}.drop uploaded as-is`, () => {
      const reading = readUpload(hostText(bytes), decodeDrop);
      expect(reading.bytes).toEqual(bytes);
      expect(reading.result).toEqual(decodeDrop(bytes));
    });

    it(`${name}.drop uploaded base64-encoded`, () => {
      const text = Buffer.from(bytes).toString('base64');
      const reading = readUpload(hostText(Buffer.from(text)), decodeDrop);
      expect(reading.encoding).toBe('base64');
      expect(reading.bytes).toEqual(bytes);
    });
  }

  it('reports which reading applied', () => {
    // The communal drop holds a non-UTF-8 payload, so the host read the
    // file as windows-1252; an empty drop (one zero byte) is valid UTF-8.
    expect(readUpload(hostText(drop('communal')), decodeDrop).encoding).toBe(
      'windows-1252',
    );
    expect(readUpload(hostText(drop('empty')), decodeDrop).encoding).toBe(
      'utf-8',
    );
  });

  it('passes on the decoder’s own error when nothing decodes', () => {
    const tampered = new Uint8Array(drop('owned'));
    tampered[tampered.length - 2] ^= 1;
    expect(() => readUpload(hostText(tampered), decodeDrop)).toThrow(
      /Entry \d+:/,
    );
  });
});
