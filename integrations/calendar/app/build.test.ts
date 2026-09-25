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
    // Measured 103,825 bytes (about 101 KiB) with minified JS and CSS
    // (2026-09-24, the #89 designed UI with the pin-007869464 host
    // operations). The limit is that plus about 10%, rounded up to 112 KiB,
    // so a real growth fails here instead of passing silently.
    expect(bytes).toBeLessThan(112 * 1024);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/bearer|connection-code/i);
    // adapter.ts is shared with the sandbox runtime, whose intents carry an
    // `Authorization: secret:google-calendar` placeholder; relay.ts drops
    // every header but If-Match. That placeholder is the only mention.
    // The bundle is minified: one match, on one long line.
    expect(text.match(/\bauthorization[^,]*/gi)).toEqual([
      'Authorization:"secret:google-calendar"',
    ]);
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
