// @wc-ignore-file
/**
 * Builds the Calendar drive plugin to one ES module, `dist/ui.js`: the
 * string an install flow stores as the App's `plugin-source`.
 *
 *   node integrations/calendar/app/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild and for `browser/lib/src/plugin-reconcile.ts`,
 * which `../adapter.ts` imports. No npm dependencies of its own.
 * No code splitting and no CSS file: "a plugin in the drive is one module".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

/**
 * The stylesheets are TS modules exporting CSS strings (`ui/styles.ts`,
 * `calendarStyles.ts`), so tests and typecheck read them as plain strings.
 * For the bundle, each module is evaluated once and every exported string
 * goes through esbuild's own CSS minifier before it is embedded.
 */
const minifiedStyles = esbuild => ({
  name: 'minified-styles',
  setup(builder) {
    builder.onLoad(
      { filter: /[\\/]app[\\/](ui[\\/]styles|calendarStyles)\.ts$/ },
      async args => {
        const { outputFiles } = await esbuild.build({
          entryPoints: [args.path],
          bundle: true,
          format: 'esm',
          write: false,
          logLevel: 'silent',
        });
        const module = await import(
          `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
        );
        const lines = [];

        for (const [name, value] of Object.entries(module)) {
          if (typeof value !== 'string')
            throw new Error(`${args.path}: ${name} is not a CSS string`);
          const { code } = await esbuild.transform(value, {
            loader: 'css',
            minify: true,
          });
          lines.push(`export const ${name} = ${JSON.stringify(code.trim())};`);
        }

        return { contents: lines.join('\n'), loader: 'js' };
      },
    );
  },
});

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
    minify: true,
    plugins: [minifiedStyles(esbuild)],
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
