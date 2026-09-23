// @wc-ignore-file
/**
 * Builds the Pets drive plugin to one ES module, `dist/ui.js`: the string an
 * install flow stores as the App's `plugin-source`.
 *
 *   node integrations/pets/app/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild. `syncables/browser` is bundled from this repo's
 * own `syncables/src/browser.ts` rather than from npm, so the app always
 * builds against the syncables in the same commit; switch the alias to the
 * published `syncables@^0.18.0` once a package.json dependency is wanted.
 * No code splitting and no CSS file: "a plugin in the drive is one module".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

export const SYNCABLES_BROWSER = path('../../../syncables/src/browser.ts');

/** Bundles in memory; writes only when `outfile` is given. */
export async function build({ outfile } = {}) {
  const require = createRequire(path('../../../browser/package.json'));
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    entryPoints: [path('main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    legalComments: 'none',
    write: false,
    outfile: outfile ?? path('dist/ui.js'),
    alias: { 'syncables/browser': SYNCABLES_BROWSER },
    logLevel: 'silent',
  });
  const text = result.outputFiles[0].text;

  if (outfile) {
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(outfile, text);
  }

  return {
    text,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--outfile');
  const outfile = at > 0 ? process.argv[at + 1] : path('dist/ui.js');
  const out = await build({ outfile });
  console.info(`${outfile}: ${out.bytes} bytes, sha256 ${out.sha256}`);
}
