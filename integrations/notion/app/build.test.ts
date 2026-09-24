// @wc-ignore-file
import { Datatype, validateDatatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import * as shim from './tomic-lib-shim.js';

describe('Notion drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/\brequire\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource, so the size is capped at
    // the measured size plus about 10% (the owner's rule for bundle limits):
    // 115 953 bytes at #89 (syncables' read path, the catalog document,
    // devonian's Atomic Data API and the UI; JS and embedded CSS minified by
    // esbuild). A change that needs more should say why and re-measure.
    expect(bytes).toBeLessThan(128_000);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    // Not /bearer|authorization/: the bundled catalog document names its
    // security schemes (`notionBearer`, `authorizationUrl`). No header is set.
    expect(text).not.toMatch(/connection-code|x-connection/i);
    expect(text).not.toMatch(/["']authorization["']\s*:|Bearer \$\{/i);
    expect(text).not.toMatch(/\bfetch\(/);
    expect(text).not.toMatch(/node:/);
  });

  it("uses the real library's datatype values through the shim", () => {
    for (const [key, value] of Object.entries(shim.Datatype))
      expect(Datatype[key as keyof typeof Datatype]).toBe(value);
  });

  it("validates like the real library's validateDatatype for the lens's datatypes", () => {
    const samples = ['text', '', 0, 1.5, 3, true, false, ['a', 'b'], {}];

    const outcome = (fn: () => void) => {
      try {
        fn();

        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };

    for (const datatype of [
      Datatype.STRING,
      Datatype.MARKDOWN,
      Datatype.FLOAT,
      Datatype.INTEGER,
      Datatype.BOOLEAN,
      Datatype.TIMESTAMP,
      Datatype.JSON,
    ])
      for (const value of samples)
        expect(outcome(() => shim.validateDatatype(value, datatype))).toBe(
          outcome(() => validateDatatype(value as never, datatype)),
        );
    expect(() => shim.validateDatatype('2026-01-01', Datatype.DATE)).toThrow(
      /Unsupported datatype/,
    );
  });

  it("bundles devonian's Atomic Data API only, not its Node/Automerge root", () => {
    expect(text).toMatch(/Conflicting identity mapping/);
    expect(text).not.toMatch(/automerge/i);
    expect(text).not.toMatch(/DevonianClient|DevonianTable/);
  });
});
