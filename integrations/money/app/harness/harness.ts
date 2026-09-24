// @wc-ignore-file
/**
 * Screenshot harness: renders the real app (`mount`) against the fake store
 * with the host's light or dark `--t-*` tokens, then drives it into one of
 * the design's frames through the DOM. Built and driven by
 * `screenshots.mjs`; not part of the app bundle.
 *
 *   harness.html?scenario=ledger&theme=dark
 */
import { mount } from '../app.js';
import { fakeStore, seedRow, type FakeStore } from '../fakeStore.js';
import { sampleRows } from './sample.js';

/** The host's default theme values (useCreateThemeVars.ts), as in mockups.html. */
const THEMES: Record<string, Record<string, string>> = {
  light: {
    '--t-color-main': '#1b50d8',
    '--t-color-main-selected-bg': '#f1f4fd',
    '--t-color-main-selected-fg': '#0f2d7a',
    '--t-color-bg-body': '#fafafa',
    '--t-color-bg': '#ffffff',
    '--t-color-bg-1': '#f2f2f2',
    '--t-color-bg-2': '#cccccc',
    '--t-color-text': '#000000',
    '--t-color-text-light': '#666666',
    '--t-color-alert': '#cf5b5b',
    '--t-color-warning': '#f5a623',
    '--t-radius': '9px',
    '--t-font-family':
      "'Open Sans', 'Helvetica Neue', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    '--t-font-family-header':
      "'Montserrat', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  },
  dark: {
    '--t-color-main': '#6f93ea',
    '--t-color-main-selected-bg': '#06102c',
    '--t-color-main-selected-fg': '#93abea',
    '--t-color-bg-body': '#000000',
    '--t-color-bg': '#000000',
    '--t-color-bg-1': '#1a1a1a',
    '--t-color-bg-2': '#4d4d4d',
    '--t-color-text': '#ffffff',
    '--t-color-text-light': '#999999',
    '--t-color-alert': '#cf5b5b',
    '--t-color-warning': '#f5a623',
    '--t-radius': '9px',
    '--t-font-family':
      "'Open Sans', 'Helvetica Neue', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    '--t-font-family-header':
      "'Montserrat', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  },
};

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(find: () => T | null | undefined, what: string) {
  for (let i = 0; i < 200; i++) {
    const found = find();
    if (found) return found;
    await wait(20);
  }

  throw new Error(`Harness: ${what} never appeared`);
}

const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find(node =>
    node.textContent?.includes(text),
  );

async function click(root: ParentNode, selector: string, text: string) {
  (
    await until(() => byText(root, selector, text), `${selector} “${text}”`)
  ).click();
  await wait();
}

async function type(root: ParentNode, selector: string, value: string) {
  const input = await until(
    () => root.querySelector<HTMLInputElement>(selector),
    selector,
  );
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait();
}

/** Hands the app a file as if chosen in its file picker. */
export async function chooseFile(root: ParentNode, name: string, text: string) {
  const input = await until(
    () => root.querySelector<HTMLInputElement>('input[type="file"]'),
    'file input',
  );
  const transfer = new DataTransfer();
  transfer.items.add(new File([text], name, { type: 'text/plain' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(60);
}

export type Scenario = (root: HTMLElement, store: FakeStore) => Promise<void>;

export const SCENARIOS: Record<string, { rows: boolean; run?: Scenario }> = {
  'first-run': { rows: false },
  perf: { rows: false },
  ledger: {
    rows: true,
    run: async root => {
      await click(root, '.m-rowbtn, .m-item', 'Studio Noord BV');
    },
  },
  'ledger-plain': { rows: true },
  'no-results': {
    rows: true,
    run: async root => {
      await click(root, '.pl-chip', 'Last month');
      await type(root, '[data-key="search"]', 'Eneco');
    },
  },
  sources: {
    rows: true,
    run: async root => {
      await click(root, '[role="tab"]', 'Sources');
    },
  },
};

/**
 * Render budget (issues.md M-4): mounts 500 rows and times the first full
 * render (load from the fake store included) and a re-render on a filter
 * change, which re-renders the 200-row window.
 */
async function perf(root: HTMLElement): Promise<void> {
  const rows = Array.from({ length: 500 }, (_, i) =>
    seedRow(
      i % 4 ? `-${(i * 7.31).toFixed(2)}` : `${i * 3}`,
      `2026-09-${String((i % 24) + 1).padStart(2, '0')}`,
      {
        'bank-description': `Counterparty ${i % 37}\n/REMI/Invoice ${i}`,
        'money-category': i % 3 ? 'Groceries' : '',
      },
    ),
  );
  const store = fakeStore({ rows });
  const t0 = performance.now();
  await mount(root, store, { today: () => '2026-09-24', locale: 'en-GB' });
  const first = performance.now() - t0;
  const chip = byText(root, '.pl-chip', 'Out')!;
  const t1 = performance.now();
  chip.click();
  const rerender = performance.now() - t1;
  document.body.dataset.perf = JSON.stringify({
    rows: root.querySelectorAll('[data-row]').length,
    firstRenderMs: Math.round(first),
    filterRenderMs: Math.round(rerender),
  });
  document.body.dataset.ready = 'true';
}

export async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const theme = THEMES[params.get('theme') ?? 'light'] ?? THEMES.light;
  const name = params.get('scenario') ?? 'ledger';
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}`);

  for (const [token, value] of Object.entries(theme))
    document.documentElement.style.setProperty(token, value);
  document.body.style.margin = '0';
  document.body.style.background = theme['--t-color-bg-body'];
  const root = document.createElement('div');
  document.body.append(root);
  if (name === 'perf') return perf(root);
  const store = fakeStore({ rows: scenario.rows ? sampleRows() : [] });
  await mount(root, store, { today: () => '2026-09-24', locale: 'en-GB' });
  await scenario.run?.(root, store);
  await wait(80);
  document.body.dataset.ready = 'true';
}

run().catch(error => {
  document.body.dataset.ready = 'error';
  document.body.dataset.error = String(error);
});
