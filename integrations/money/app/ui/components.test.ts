// @wc-ignore-file
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  banner,
  button,
  chip,
  conn,
  empty,
  header,
  installStyles,
  panel,
  panelMode,
  pill,
  tabs,
} from './components.js';
import { PLUGIN_CSS } from './css.js';
import { replaceKeepingFocus, trapTab } from './focus.js';
import { h } from './dom.js';

describe('plugin shell components', () => {
  it('the pill is the status live region and names its state in text', () => {
    const node = pill('syncing', 'Checking balances…');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.dataset.state).toBe('syncing');
    expect(node.textContent).toBe('Checking balances…');
  });

  it('neg and warn banners are alerts with a focusable title; details hold the raw message', () => {
    const node = banner({
      tone: 'neg',
      title: 'Balances in this statement don’t add up',
      text: 'Nothing was imported.',
      details: 'Statement balance does not reconcile',
    });
    expect(node.getAttribute('role')).toBe('alert');
    expect(node.dataset.tone).toBe('neg');
    const title = node.querySelector('h3')!;
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(title.textContent).not.toContain('reconcile');
    expect(node.querySelector('details summary')!.textContent).toBe(
      'Technical details',
    );
    expect(node.querySelector('details p')!.textContent).toBe(
      'Statement balance does not reconcile',
    );
    expect(banner({ tone: 'warn', text: 'x' }).getAttribute('role')).toBe(
      'alert',
    );
    expect(banner({ tone: 'info', text: 'x' }).getAttribute('role')).toBe(
      'note',
    );
  });

  it('header puts name, context, status and one action in order', () => {
    const node = header({
      title: 'Money',
      context: h('button', {}, 'All accounts'),
      status: pill('idle', 'No transactions yet'),
      action: button('Import statement', { variant: 'primary' }),
    });
    expect(node.className).toBe('pl-header');
    expect(node.querySelector('h1')!.textContent).toBe('Money');
    expect([...node.children].map(c => c.className || c.tagName)).toEqual([
      'H1',
      'pl-context',
      'pl-spacer',
      'pl-pill',
      'pl-btn',
    ]);
  });

  it('icon-only buttons carry an aria-label; chips carry aria-pressed', () => {
    const icon = button('↑', { iconOnly: true, ariaLabel: 'Import statement' });
    expect(icon.getAttribute('aria-label')).toBe('Import statement');
    expect(icon.type).toBe('button');
    expect(
      chip('This month', true, () => {}).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('empty and conn blocks have the shared class names', () => {
    expect(empty({ heading: 'x', text: 'y' }).className).toBe('pl-empty');
    const bar = conn({
      source: 'Moneybird',
      text: 'Not connected',
      tone: 'warn',
    });
    expect(bar.className).toBe('pl-conn');
    expect(bar.dataset.tone).toBe('warn');
  });

  it('tabs are a tablist with one selected tab', () => {
    const node = tabs(
      [
        { id: 'a', label: 'Transactions', count: '3' },
        { id: 'b', label: 'Imports' },
      ],
      'a',
      () => {},
      'Views',
    );
    expect(node.getAttribute('role')).toBe('tablist');
    const selected = node.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe('Transactions3');
  });

  it('the panel is a non-modal region when docked and a modal dialog otherwise', () => {
    expect(panelMode(1200)).toBe('side');
    expect(panelMode(720)).toBe('drawer');
    expect(panelMode(360)).toBe('sheet');
    expect(panel('side', 'Transaction details').getAttribute('role')).toBe(
      'region',
    );
    const modal = panel('sheet', 'Transaction details');
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
  });

  it('styles: every token has a light fallback; reduced motion stops the pulse', () => {
    for (const token of [
      '--t-color-bg-body, #fafafa',
      '--t-color-bg, #ffffff',
      '--t-color-bg-1, #f2f2f2',
      '--t-color-bg-2, #cccccc',
      '--t-color-text, #000000',
      '--t-color-text-light, #666666',
      '--t-color-main, #1b50d8',
      '--t-color-alert, #cf5b5b',
      '--t-color-warning, #f5a623',
    ])
      expect(PLUGIN_CSS).toContain(token);
    expect(PLUGIN_CSS).not.toMatch(/prefers-color-scheme/);
    const reduced = PLUGIN_CSS.slice(
      PLUGIN_CSS.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    expect(reduced).toMatch(
      /\.pl-pill\[data-state='syncing'\]::before \{ animation: none; \}/,
    );
  });

  it('installs one style element per document', () => {
    installStyles(document, 'x-styles', '.x{}');
    installStyles(document, 'x-styles', '.x{}');
    expect(document.querySelectorAll('#x-styles')).toHaveLength(1);
  });

  it('keeps focus and caret on a keyed field across a re-render', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const field = () => h('input', { 'data-key': 'q', value: 'Vattenfall' });
    root.replaceChildren(field());
    const first = root.querySelector('input')!;
    first.focus();
    first.setSelectionRange(3, 3);
    replaceKeepingFocus(root, [field()]);
    const second = root.querySelector('input')!;
    expect(second).not.toBe(first);
    expect(document.activeElement).toBe(second);
    expect(second.selectionStart).toBe(3);
  });

  it('traps Tab inside a modal', () => {
    const dialog = h('div', {}, h('button', {}, 'a'), h('button', {}, 'b'));
    document.body.append(dialog);
    const [a, b] = dialog.querySelectorAll('button');
    b.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      cancelable: true,
    });
    trapTab(dialog, event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
  });
});
