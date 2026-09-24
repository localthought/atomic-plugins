// @wc-ignore-file
/**
 * Builds the Money drive app to one ES module, `dist/ui.js`: the string an
 * install flow stores as the App's `plugin-source`.
 *
 *   node integrations/money/app/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild. No npm dependencies: the statement readers come
 * from this package (`../statement.ts`), the rest is plain DOM.
 * No code splitting and no CSS file: "a plugin in the drive is one module".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

/** Modules whose one export is a stylesheet in a template literal. */
const STYLESHEETS = /[\\/]app[\\/](ui[\\/]css|styles)\.ts$/;

/**
 * Minifies the embedded stylesheets with esbuild's CSS minifier before they
 * are bundled, so the module carries them without source whitespace. The
 * source stays readable; only the build output is minified.
 */
const minifiedStylesheets = esbuild => ({
  name: 'money-minified-stylesheets',
  setup(plugin) {
    plugin.onLoad({ filter: STYLESHEETS }, async args => {
      const source = readFileSync(args.path, 'utf8');
      const match = source.match(/export const (\w+) = `([^`]*)`;/);
      if (!match || match[2].includes('${'))
        throw new Error(`${args.path}: expected one plain template literal`);
      const { code } = await esbuild.transform(match[2], {
        loader: 'css',
        minify: true,
      });

      return {
        contents: `export const ${match[1]} = ${JSON.stringify(code.trim())};`,
        loader: 'ts',
      };
    });
  },
});

/** Bundles in memory; writes only when `outfile` is given. */
export async function build({ outfile } = {}) {
  const require = createRequire(path('../../../browser/package.json'));
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    entryPoints: [path('main.ts')],
    // esbuild's `// path` comments are relative to this, so pin it to the
    // repository root: the bytes (and the catalog's integrity hash for them)
    // must not depend on the directory the build was started from.
    absWorkingDir: path('../../..'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    legalComments: 'none',
    minify: true,
    plugins: [minifiedStylesheets(esbuild)],
    write: false,
    outfile: outfile ?? path('dist/ui.js'),
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
