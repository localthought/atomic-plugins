// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import * as shim from './tomic-lib-shim.js';

describe('drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource: keep an eye on the size.
    // Measured 89,560 bytes (87.5 KB) with the #89 views: JS minified by
    // esbuild, the stylesheet (ui/theme.css, about 18 KB) by esbuild's CSS
    // minifier. The limit is that plus about 10%, rounded up; it was 64 KB
    // before the views. A bigger jump should be a visible decision.
    expect(bytes).toBeLessThan(97 * 1024);
  });

  it('carries no credential handling of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("uses the real library's datatype values through the shim", () => {
    expect(shim.Datatype.TIMESTAMP).toBe(Datatype.TIMESTAMP);
  });
});
