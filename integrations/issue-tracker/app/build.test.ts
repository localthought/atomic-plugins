// @wc-ignore-file
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { core, dataBrowser, Datatype, validateDatatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import * as shim from './tomic-lib-shim.js';

describe('GitHub issues drive-app bundle', async () => {
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
    // Stored as a string property on a resource; keep an eye on the size.
    expect(bytes).toBeLessThan(128 * 1024);
  });

  it('has no storage or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/\bfetch\(/);
    expect(text).not.toMatch(/navigator\.locks/);
    expect(text).not.toMatch(/node:/);
    // No connection codes any more (#54 phase 2): proxyTransport only
    // dispatches through the host.
    expect(text).not.toMatch(/x-connection-code|getCode|setCode/i);
  });

  it("bundles devonian's Atomic Data API and reconcileRecord only", () => {
    expect(text).toMatch(/Conflicting identity mapping/);
    expect(text).not.toMatch(/automerge/i);
    expect(text).not.toMatch(/DevonianClient|DevonianTable|BackgroundSync/);
  });

  it("uses the real library's values through the shim", () => {
    for (const [key, value] of Object.entries(shim.Datatype))
      expect(Datatype[key as keyof typeof Datatype]).toBe(value);
    for (const [key, value] of Object.entries(shim.core.properties))
      expect(core.properties[key as keyof typeof core.properties]).toBe(value);
    for (const [key, value] of Object.entries(shim.core.classes))
      expect(core.classes[key as keyof typeof core.classes]).toBe(value);
    for (const [key, value] of Object.entries(shim.dataBrowser.properties))
      expect(
        dataBrowser.properties[key as keyof typeof dataBrowser.properties],
      ).toBe(value);
    for (const [key, value] of Object.entries(shim.dataBrowser.classes))
      expect(dataBrowser.classes[key as keyof typeof dataBrowser.classes]).toBe(
        value,
      );
  });

  it("validates like the real library's validateDatatype", () => {
    const samples = ['text', '', 0, 1.5, 3, true, false, ['a'], {}];

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
      Datatype.INTEGER,
      Datatype.FLOAT,
      Datatype.BOOLEAN,
      Datatype.TIMESTAMP,
      Datatype.JSON,
    ])
      for (const value of samples)
        expect(outcome(() => shim.validateDatatype(value, datatype))).toBe(
          outcome(() => validateDatatype(value as never, datatype)),
        );
  });
});

describe('GitHub issues drive-app types', () => {
  // vitest strips types without checking them; the lane has no typecheck
  // tier for app/, so its tsconfig is checked here.
  it('typechecks', () => {
    const tsc = fileURLToPath(
      new URL('../../../browser/node_modules/.bin/tsc', import.meta.url),
    );
    const result = spawnSync(
      tsc,
      ['-p', fileURLToPath(new URL('tsconfig.json', import.meta.url))],
      { encoding: 'utf8' },
    );
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, 120_000);
});
