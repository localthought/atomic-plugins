// @vitest-environment jsdom
// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { APP_CSS } from '../styles.js';
import { KIT_CSS } from './css.js';
import {
  banner,
  button,
  chip,
  connectionBar,
  empty,
  header,
  pill,
  searchField,
  segmented,
  statusGlyph,
  type PillState,
} from './kit.js';
import { injectStyles, luminance, watchFrame } from './theme.js';

describe('the shared kit', () => {
  it('draws each pill state with its own icon shape and one status role', () => {
    const states: PillState[] = [
      'idle',
      'synced',
      'syncing',
      'paused',
      'reauth',
      'error',
    ];
    const shapes = states.map(state => {
      const node = pill(state, state);
      expect(node.dataset.state).toBe(state);
      expect(node.getAttribute('role')).toBe('status');
      expect(node.textContent).toBe(state);

      return node.querySelector('svg')!.innerHTML;
    });
    expect(new Set(shapes).size).toBe(states.length);

    const clickable = pill('error', 'Sync failed', () => {});
    expect(clickable.tagName).toBe('BUTTON');
    expect(clickable.querySelectorAll('[role=status]')).toHaveLength(1);
  });

  it('renders banner tones, and an alert role only when asked', () => {
    for (const tone of ['neg', 'warn', 'info'] as const) {
      const node = banner({
        tone,
        icon: 'warn',
        title: 'Title.',
        text: 'Text',
      });
      expect(node.dataset.tone).toBe(tone);
      expect(node.getAttribute('role')).toBeNull();
      expect(node.textContent).toBe('Title. Text');
    }

    const raised = banner({
      tone: 'neg',
      icon: 'plug',
      title: 'Refused.',
      alert: true,
      actions: [button('Retry', () => {})],
      details: 'GitHub list_issues returned 401',
    });
    expect(raised.querySelector('.pl-banner')!.getAttribute('role')).toBe(
      'alert',
    );
    expect(raised.querySelector('details code')!.textContent).toBe(
      'GitHub list_issues returned 401',
    );
    expect(raised.querySelector('.b-actions button')!.textContent).toBe(
      'Retry',
    );
  });

  it('builds header, connection bar with progress, empty state and search', () => {
    const top = header('Issues', 'extra');
    expect(top.querySelector('h1')!.textContent).toBe('Issues');
    const bar = connectionBar(['GitHub', 'Last sync 09:41'], [], 0.4);
    expect(bar.textContent).toBe('GitHub·Last sync 09:41');
    expect(
      (bar.querySelector('.progress') as HTMLElement).style.getPropertyValue(
        '--p',
      ),
    ).toBe('40%');
    expect(
      connectionBar(['x'], [], true).querySelector('.indeterminate'),
    ).not.toBeNull();
    const e = empty(
      'inbox',
      'Nothing here.',
      'Add one.',
      button('New', () => {}),
    );
    expect(e.querySelector('p')!.textContent).toBe('Nothing here.Add one.');
    let typed = '';
    const { input } = searchField('Search issues', 'abc', v => (typed = v));
    expect(input.value).toBe('abc');
    input.value = 'abcd';
    input.dispatchEvent(new Event('input'));
    expect(typed).toBe('abcd');
  });

  it('keeps label colour to the dot, and only a valid hex', () => {
    const c = chip('bug', '#d73a4a');
    expect(c.textContent).toBe('bug');
    expect(c.style.background).toBe('');
    expect((c.querySelector('i') as HTMLElement).style.background).not.toBe('');
    const bad = chip('x', 'red;background:url(x)');
    expect((bad.querySelector('i') as HTMLElement).style.background).toBe('');
  });

  it('draws the status glyphs as three shapes', () => {
    const glyphs = (['todo', 'doing', 'done'] as const).map(s =>
      statusGlyph(s),
    );
    expect(glyphs.map(g => g.getAttribute('class'))).toEqual([
      'glyph g-todo',
      'glyph g-doing',
      'glyph g-done',
    ]);
    expect(new Set(glyphs.map(g => g.innerHTML)).size).toBe(3);
  });

  it('segmented control: pressed toggles, or a radiogroup with arrow keys', () => {
    let picked = '';
    const group = segmented(
      'Layout',
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      'a',
      v => (picked = v),
    );
    expect(group.getAttribute('role')).toBe('group');
    expect(
      [...group.querySelectorAll('button')].map(b =>
        b.getAttribute('aria-pressed'),
      ),
    ).toEqual(['true', 'false']);
    (group.querySelectorAll('button')[1] as HTMLElement).click();
    expect(picked).toBe('b');

    const radio = segmented(
      'Status',
      [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
      ],
      'x',
      v => (picked = v),
      { mode: 'radio' },
    );
    expect(radio.getAttribute('role')).toBe('radiogroup');
    radio.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(picked).toBe('y');
  });
});

describe('theme tokens', () => {
  // Formatting-independent: no whitespace around punctuation.
  const css = (KIT_CSS + APP_CSS)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([:;{},>])\s*/g, '$1');

  it('uses no literal colour except the --pl-pos fallback', () => {
    const literals = css
      .split(/[;{}]/)
      .filter(decl => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(decl));
    expect(literals.map(d => d.trim())).toEqual([
      '--pl-pos:var(--t-color-success,#2f8f5b)',
      '--pl-pos:var(--t-color-success,#5cc48a)',
    ]);
  });

  it('never reads the OS colour scheme', () => {
    expect(css).not.toMatch(/prefers-color-scheme/);
  });

  it('aliases every --pl-* token from a host --t-* variable', () => {
    for (const [token, host] of [
      ['--pl-bg', '--t-color-bg-body'],
      ['--pl-surface', '--t-color-bg'],
      ['--pl-sunken', '--t-color-bg-1'],
      ['--pl-border', '--t-color-bg-2'],
      ['--pl-text', '--t-color-text'],
      ['--pl-muted', '--t-color-text-light'],
      ['--pl-accent', '--t-color-main'],
      ['--pl-accent-soft', '--t-color-main-selected-bg'],
      ['--pl-accent-ink', '--t-color-main-selected-fg'],
      ['--pl-on-accent', '--t-color-bg'],
      ['--pl-neg', '--t-color-alert'],
      ['--pl-warn', '--t-color-warning'],
    ])
      expect(css).toContain(`${token}:var(${host})`);
    expect(css).toContain(
      '--pl-hairline:color-mix(in srgb,var(--t-color-bg-2) 55%,var(--t-color-bg))',
    );
    expect(css).toContain(
      "[data-pl-scheme='dark']{--pl-pos:var(--t-color-success,#5cc48a);}",
    );
  });

  it('follows the host theme for --pl-pos, light and dark', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000')).toBe(0);
    expect(luminance('rgb(250, 250, 250)')).toBeGreaterThan(0.9);
    expect(luminance('nonsense')).toBeUndefined();

    const root = document.createElement('div');
    document.body.append(root);
    injectStyles(root, '');
    injectStyles(root, '');
    expect(document.querySelectorAll('#pl-app-styles')).toHaveLength(1);

    document.documentElement.style.setProperty('--t-color-bg', '#000000');
    const stop = watchFrame(root, () => {});
    expect(root.dataset.plScheme).toBe('dark');
    stop();
    document.documentElement.style.setProperty('--t-color-bg', '#ffffff');
    watchFrame(root, () => {})();
    expect(root.dataset.plScheme).toBe('light');
  });
});

describe('host theme calls', () => {
  it('uses the host colorScheme over the background, and follows changes', () => {
    const root = document.createElement('div');
    document.body.append(root);
    document.documentElement.style.setProperty('--t-color-bg', '#ffffff');
    let listener: ((t: { colorScheme?: 'light' | 'dark' }) => void) | undefined;
    const stop = watchFrame(root, () => {}, {
      getTheme: () => ({ colorScheme: 'dark' }),
      onThemeChange: h => {
        listener = h;

        return () => (listener = undefined);
      },
    });
    expect(root.dataset.plScheme).toBe('dark');
    listener!({ colorScheme: 'light' });
    expect(root.dataset.plScheme).toBe('light');
    stop();
    expect(listener).toBeUndefined();
  });

  it('takes the success colour from the host', () => {
    expect(KIT_CSS).toContain('--pl-pos: var(--t-color-success, #2f8f5b)');
  });
});
