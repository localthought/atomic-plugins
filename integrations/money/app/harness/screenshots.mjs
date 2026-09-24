// @wc-ignore-file
/**
 * Renders the Money app's states with the fake store and screenshots them
 * at the design's frame widths, in the host's light and dark tokens, for
 * comparison with `design/mockups.html`.
 *
 *   node integrations/money/app/harness/screenshots.mjs [--out dir] [--only name]
 *
 * Needs the atomic-server checkout's `browser/` (esbuild, Playwright and its
 * Chromium). Writes PNGs to `integrations/money/app/dist/screenshots/` by
 * default (gitignored).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));
const require = createRequire(path('../../../../browser/package.json'));
const esbuild = require('esbuild');
const e2e = createRequire(path('../../../../browser/e2e/package.json'));
const { chromium } = e2e('@playwright/test');

const arg = name => {
  const at = process.argv.indexOf(name);

  return at > 0 ? process.argv[at + 1] : undefined;
};

/** [scenario, width, theme]: the widths and themes the mockups use. */
export const SHOTS = [
  ['first-run', 720, 'light'],
  ['first-run', 360, 'dark'],
  ['ledger', 1200, 'light'],
  ['ledger', 1200, 'dark'],
  ['ledger', 720, 'light'],
  ['ledger-plain', 360, 'dark'],
  ['ledger-plain', 360, 'light'],
  ['detail', 360, 'light'],
  ['detail-error', 360, 'light'],
  ['no-results', 720, 'dark'],
  ['sources', 720, 'light'],
  ['imports', 720, 'light'],
  ['imports', 360, 'dark'],
  ['checking', 720, 'light'],
  ['preview', 900, 'light'],
  ['preview', 900, 'dark'],
  ['preview-nothing-new', 720, 'light'],
  ['error-balance', 720, 'light'],
  ['conflict', 720, 'light'],
  ['conflict', 360, 'dark'],
];

export async function shoot({ out = path('../dist/screenshots'), only } = {}) {
  mkdirSync(out, { recursive: true });
  const bundle = await esbuild.build({
    entryPoints: [path('harness.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  // Inline: Chromium refuses module scripts from file:// URLs.
  const script = bundle.outputFiles[0].text.replaceAll(
    '</script',
    '<\\/script',
  );
  writeFileSync(
    `${out}/harness.html`,
    `<!doctype html><meta charset="utf-8"><title>Money harness</title><body><script type="module">${script}</script>`,
  );
  const page = pathToFileURL(`${out}/harness.html`).href;
  const browser = await chromium.launch();
  const written = [];

  try {
    for (const [scenario, width, theme] of SHOTS) {
      if (only && scenario !== only) continue;
      const tab = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
      });
      const errors = [];
      tab.on('pageerror', e => errors.push(String(e)));
      await tab.goto(`${page}?scenario=${scenario}&theme=${theme}`);
      await tab.waitForFunction(() => document.body.dataset.ready, null, {
        timeout: 15000,
      });
      const state = await tab.evaluate(() => ({
        ready: document.body.dataset.ready,
        error: document.body.dataset.error,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      if (state.ready === 'error' || errors.length)
        throw new Error(
          `${scenario}: ${state.error ?? ''} ${errors.join('; ')}`.trim(),
        );
      if (state.scrollWidth > width)
        console.warn(
          `${scenario} @${width}: page scrolls horizontally (${state.scrollWidth}px)`,
        );
      const file = `${out}/${scenario}-${width}-${theme}.png`;
      await tab.screenshot({ path: file, fullPage: true });
      written.push(file);
      await tab.close();
    }

    if (!only || only === 'perf') {
      const tab = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      await tab.goto(`${page}?scenario=perf`);
      await tab.waitForFunction(() => document.body.dataset.ready);
      console.info(
        'render budget (500 rows):',
        await tab.evaluate(() => document.body.dataset.perf),
      );
      await tab.close();
    }
  } finally {
    await browser.close();
  }

  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await shoot({ out: arg('--out'), only: arg('--only') });
  for (const file of files) console.info(file);
}
