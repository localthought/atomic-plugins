// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('calendar drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    // `__require` is esbuild's wrapper for fast-json-stable-stringify (a
    // CommonJS dependency of plugin-reconcile.ts), not a module loader.
    expect(text).not.toMatch(/node:|(?<![\w$])require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource: keep an eye on the size.
    // The designed UI (#89) is about 170 KB unminified, most of it the
    // stylesheet and view code; build.mjs does not minify.
    expect(bytes).toBeLessThan(224 * 1024);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/bearer|connection-code/i);
    // adapter.ts is shared with the sandbox runtime, whose intents carry an
    // `Authorization: secret:google-calendar` placeholder; relay.ts drops
    // every header but If-Match. That placeholder is the only mention.
    expect(text.match(/authorization[^\n]*/gi)).toEqual([
      'Authorization: "secret:google-calendar",',
    ]);
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
