// @wc-ignore-file
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('money drive-app bundle', async () => {
  const first = (await build()) as { text: string; bytes: number };
  const { text, bytes } = first;

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/node:|require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource: keep an eye on the size.
    // Measured 83,637 bytes minified (JS and embedded CSS) on 2026-09-24,
    // at the 007869464 pin; the limit is that plus about 10%, rounded up.
    // It includes both statement readers (MT940 and camt.053), which the
    // in-app check runs.
    expect(bytes).toBeLessThan(92_000);
  });

  it('embeds its stylesheets minified', () => {
    expect(text).toContain('.pl-app{');
    expect(text).not.toMatch(/\\n\s+--pl-/);
    expect(text).not.toMatch(/\n\s+--pl-/);
    expect(text).not.toMatch(/\/\* (Header|Summary strip) \*\//);
  });

  it('is reproducible', async () => {
    const second = (await build()) as { text: string };
    expect(second.text).toBe(text);
  });

  it('carries no network access, credentials or browser storage', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    // No host relay call sites: Money reads and writes only the drive.
    expect(text).not.toMatch(/\.proxy\b/);
  });

  it('ships no stylesheet file: styles live in the module', () => {
    const files = readdirSync(new URL('.', import.meta.url));
    expect(files.filter(f => f.endsWith('.css'))).toEqual([]);
  });

  it('marks every TypeScript source with @wc-ignore-file', () => {
    for (const dir of ['.', './ui', './harness'])
      for (const file of readdirSync(new URL(dir + '/', import.meta.url)))
        if (/\.(ts|mjs)$/.test(file))
          expect(
            readFileSync(new URL(`${dir}/${file}`, import.meta.url), 'utf8'),
            file,
          ).toMatch(/^\/\/ @wc-ignore-file/);
  });
});
