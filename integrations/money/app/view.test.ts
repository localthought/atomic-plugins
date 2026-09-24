// @wc-ignore-file
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from './app.js';
import { fakeStore, seedRow, type FakeStore } from './fakeStore.js';
import { sampleRows } from './harness/sample.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function open(store: FakeStore, width = 1200) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  await mount(root, store, {
    today: () => '2026-09-24',
    locale: 'en-GB',
    width,
  });

  return root;
}

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('Money view: first run', () => {
  beforeEach(() => document.head.replaceChildren());

  it('shows the first-run empty state with a file button and Moneybird disabled', async () => {
    const root = await open(fakeStore());
    expect(text(root.querySelector('.pl-empty h2'))).toBe(
      'Bring in your bank transactions',
    );
    expect(text(root.querySelector('[role="status"]'))).toBe(
      'No transactions yet',
    );
    const connect = [...root.querySelectorAll('button')].find(
      b => text(b) === 'Connect',
    )!;
    expect(connect.disabled).toBe(true);
    expect(text(connect.closest('.m-src'))).toContain('Not available yet');
    // One style element, in the head: no stylesheet file.
    expect(document.querySelectorAll('style#money-app-styles')).toHaveLength(1);
  });

  it('refuses a table of another class with a banner, not an empty ledger', async () => {
    const root = await open(fakeStore({ data: 'other' }));
    expect(root.querySelector('.pl-banner')?.getAttribute('role')).toBe(
      'alert',
    );
    expect(text(root.querySelector('.pl-banner'))).toContain(
      'Bank transactions table',
    );
  });
});

describe('Money view: ledger', () => {
  it('renders a captioned table with day row groups and spoken amounts at ≥560px', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }));
    const table = root.querySelector('table.m-ledger')!;
    expect(text(table.querySelector('caption'))).toBe(
      'All accounts · September 2026 · 14 transactions',
    );
    const days = table.querySelectorAll('th[scope="rowgroup"]');
    expect(text(days[0])).toMatch(/^Tue 22 Sept?\s*−€873\.47$/);
    const amount = table.querySelector('.m-row .m-amt')!;
    expect(text(amount)).toBe('−€850.00');
    expect(amount.getAttribute('aria-label')).toBe('minus 850 euro');
    const money = [...table.querySelectorAll('.m-amt[data-dir="in"]')].map(
      text,
    );
    expect(money).toContain('+€2,420.00');
  });

  it('renders a list of buttons below 560px, with the currency after the amount', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }), 360);
    expect(root.querySelector('table')).toBeNull();
    const item = root.querySelector('ul.m-list button.m-item')!;
    expect(text(item)).toContain('Kantoorhuur De Werkplaats BV');
    expect(text(item.querySelector('.m-amt'))).toBe('−850.00EUR');
    const icon = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Import statement"]',
    )!;
    expect(icon.dataset.iconOnly).toBe('');
  });

  it('filters by search, and names query and period when nothing matches', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }));
    const field = () =>
      root.querySelector<HTMLInputElement>('[data-key="search"]')!;
    field().value = 'kpn';
    field().dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelectorAll('.m-row')).toHaveLength(1);
    // Focus and caret survive the re-render.
    const search = field();
    search.focus();
    search.value = 'Eneco';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect((document.activeElement as HTMLElement | null)?.dataset.key).toBe(
      'search',
    );
    expect(text(root.querySelector('.pl-empty p'))).toBe(
      'No transactions match “Eneco” in September 2026.',
    );
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => text(b) === 'Clear filters')!
      .click();
    expect(root.querySelectorAll('.m-row')).toHaveLength(19);
  });

  it('switches account from the strip and the switcher', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }));
    const segments = root.querySelectorAll<HTMLButtonElement>('.m-seg');
    expect(segments).toHaveLength(3);
    segments[1].click();
    expect(text(root.querySelector('caption'))).toMatch(
      /^NL18 RABO 0301 2244 56 · EUR · September 2026 · 1 transaction$/,
    );
    const select = root.querySelector<HTMLSelectElement>('select.m-switcher')!;
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text(root.querySelector('caption'))).toMatch(/^All accounts/);
  });

  it('shows 200 rows, then earlier ones on request', async () => {
    const rows = Array.from({ length: 450 }, (_, i) =>
      seedRow(`-${i + 1}`, `2026-09-${String((i % 20) + 1).padStart(2, '0')}`),
    );
    const root = await open(fakeStore({ rows }));
    expect(root.querySelectorAll('.m-row')).toHaveLength(200);
    const more = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      b => text(b) === 'Show earlier transactions',
    )!;
    more.click();
    expect(root.querySelectorAll('.m-row')).toHaveLength(400);
  });

  it('shows new rows from an import without a reload, and says so', async () => {
    const store = fakeStore({ rows: sampleRows() });
    const root = await open(store);
    store.addRows([seedRow('-9.99', '2026-09-23')]);
    await settle();
    await settle();
    expect(text(root.querySelector('[role="status"]'))).toBe(
      'Imported 1 · just now',
    );
    expect(root.querySelectorAll('.m-row')).toHaveLength(15);
  });
});

describe('Money view: detail', () => {
  const selectFirst = (root: HTMLElement, name = 'Studio Noord BV') =>
    [...root.querySelectorAll<HTMLElement>('[data-row]')]
      .find(b => text(b).includes(name))!
      .click();

  it('docks a labelled region at ≥900px with only category and note editable', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }));
    selectFirst(root);
    const panel = root.querySelector('.pl-panel')!;
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-label')).toBe('Transaction details');
    const controls = panel.querySelectorAll('input, textarea, select');
    expect([...controls].map(c => c.id)).toEqual([
      'money-category',
      'money-note',
    ]);
    expect(
      (panel.querySelector('#money-category') as HTMLInputElement).value,
    ).toBe('Revenue');
    expect(text(panel.querySelector('pre.m-narr'))).toContain(
      '/REMI/Factuur 2026-031/EREF/NOTPROVIDED',
    );
    expect(text(panel.querySelector('.m-kv'))).toContain(
      'NL42 BUNQ 0123 4567 89 · EUR',
    );
  });

  it('is a modal sheet below 560px; Escape closes it and focus returns to the row', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }), 360);
    selectFirst(root);
    const sheet = root.querySelector('.pl-panel')!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Back to transactions',
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.querySelector('.pl-panel')).toBeNull();
    expect(text(document.activeElement)).toContain('Studio Noord BV');
  });

  it('saves on change and shows the failure inline with Retry, keeping the text', async () => {
    const store = fakeStore({ rows: sampleRows() });
    const root = await open(store, 360);
    selectFirst(root, 'Albert Heijn');
    const input = root.querySelector<HTMLInputElement>('#money-category')!;
    input.value = 'Office supplies';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await settle();
    const banner = root.querySelector('.pl-panel .pl-banner')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(text(banner)).toContain("Couldn't save the category.");
    expect(root.querySelector<HTMLInputElement>('#money-category')!.value).toBe(
      'Office supplies',
    );
    expect([...banner.querySelectorAll('button')].map(b => text(b))).toContain(
      'Retry',
    );
  });

  it('moves between rows with the arrow keys', async () => {
    const root = await open(fakeStore({ rows: sampleRows() }));
    const rows = root.querySelectorAll<HTMLElement>('[data-row]');
    rows[0].focus();
    rows[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1].tabIndex).toBe(0);
    expect(rows[0].tabIndex).toBe(-1);
  });
});
