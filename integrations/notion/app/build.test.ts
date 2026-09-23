// @wc-ignore-file
import { Datatype } from '@tomic/lib';
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
    // Stored as a string property on a resource: it bundles syncables'
    // read path and the catalog document, so keep an eye on the size.
    expect(bytes).toBeLessThan(160 * 1024);
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
    expect(shim.Datatype).toEqual({
      STRING: Datatype.STRING,
      FLOAT: Datatype.FLOAT,
      BOOLEAN: Datatype.BOOLEAN,
    });
  });
});
