// @wc-ignore-file
/**
 * Builds the GitHub issues drive app to one ES module, `dist/ui.js`: the
 * string an install flow stores as the App's `plugin-source`.
 *
 *   node integrations/issue-tracker/app/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild, and `pnpm install --frozen-lockfile` in
 * integrations/issue-tracker/app/ for the npm `devonian` it bundles. The
 * lens in `../devonian/github-issues/` resolves `devonian` from there too
 * (`nodePaths`), not from this repo's `devonian/` sources.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

/**
 * `import css from './x.css?raw'` (as Vite reads it in the tests) embeds the
 * stylesheet as a string, minified by esbuild's CSS minifier first.
 */
const minifiedCss = esbuild => ({
  name: 'minified-css-text',
  setup(bundle) {
    bundle.onResolve({ filter: /\.css\?raw$/ }, args => ({
      path: fileURLToPath(
        new URL(
          args.path.slice(0, -'?raw'.length),
          `file://${args.resolveDir}/`,
        ),
      ),
      namespace: 'css-text',
    }));
    bundle.onLoad({ filter: /.*/, namespace: 'css-text' }, async args => {
      const { code } = await esbuild.transform(
        readFileSync(args.path, 'utf8'),
        {
          loader: 'css',
          minify: true,
        },
      );

      return { contents: code, loader: 'text' };
    });
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
    write: false,
    outfile: outfile ?? path('dist/ui.js'),
    nodePaths: [path('node_modules')],
    alias: {
      '@tomic/lib': path('tomic-lib-shim.ts'),
      // adapter.ts takes reconcileRecord from the host module the sandbox
      // plugin was built against; devonian exports the same function.
      '@integration-host/plugin-reconcile': 'devonian',
    },
    plugins: [minifiedCss(esbuild)],
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
