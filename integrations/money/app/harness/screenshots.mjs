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
const { AxeBuilder } = e2e('@axe-core/playwright');

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

/** WCAG 2 contrast ratio of two computed colours (`rgb(...)` or `color(srgb ...)`). */
function contrast(a, b) {
  const lum = color => {
    const nums = color.match(/[\d.]+/g).map(Number);
    const rgb = color.startsWith('color(')
      ? nums.slice(0, 3)
      : nums.slice(0, 3).map(n => n / 255);
    const [r, g, bl] = rgb.map(c =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );

    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };

  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);

  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export async function shoot({
  out = path('../dist/screenshots'),
  only,
  axe = false,
} = {}) {
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
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Money harness</title><body><script type="module">${script}</script>`,
  );
  const page = pathToFileURL(`${out}/harness.html`).href;
  const browser = await chromium.launch();
  const written = [];

  try {
    for (const [scenario, width, theme] of SHOTS) {
      if (only && scenario !== only) continue;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
      });
      const tab = await context.newPage();
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
      // A modal is fixed to the viewport: capture that, not the page under it.
      const modal = await tab.$('[aria-modal="true"]');
      await tab.screenshot({ path: file, fullPage: !modal });
      written.push(file);

      if (axe) {
        const result = await new AxeBuilder({ page: tab }).analyze();
        const bad = result.violations.filter(v =>
          ['serious', 'critical'].includes(v.impact),
        );
        console.info(
          `axe ${scenario} @${width} ${theme}: ${bad.length} serious/critical` +
            bad
              .map(
                v =>
                  `\n  ${v.id}: ${v.nodes.length} × ${v.help}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`,
              )
              .join(''),
        );
      }

      if (scenario === 'ledger') {
        const colors = await tab.evaluate(() => {
          // Resolve any CSS colour (oklab from color-mix included) to sRGB.
          const ctx = document.createElement('canvas').getContext('2d');

          const rgb = color => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

            return `rgb(${r}, ${g}, ${b})`;
          };

          const pos = document.querySelector('.m-row .m-amt[data-dir="in"]');
          const muted = document.querySelector('.m-acctcell');

          return {
            pos: rgb(getComputedStyle(pos).color),
            muted: rgb(getComputedStyle(muted).color),
            bg: rgb(
              getComputedStyle(document.querySelector('.pl-app'))
                .backgroundColor,
            ),
          };
        });
        console.info(
          `contrast ${theme}: --pl-pos ${colors.pos} on ${colors.bg} = ${contrast(colors.pos, colors.bg)}:1, --pl-muted ${contrast(colors.muted, colors.bg)}:1`,
        );
      }

      await context.close();
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
  const files = await shoot({
    out: arg('--out'),
    only: arg('--only'),
    axe: process.argv.includes('--axe'),
  });
  for (const file of files) console.info(file);
}
