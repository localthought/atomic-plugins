// @wc-ignore-file
/**
 * DOM builders for the shared #89 plugin shell (DESIGN.md §4). Each returns a
 * fresh element with the roles and ARIA the design documents; styling is
 * `PLUGIN_CSS` in `./css.ts`. Nothing here is Money-specific.
 */
import { h, type Child } from './dom.js';
import { PLUGIN_CSS } from './css.js';

export type PillState =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'paused'
  | 'reauth'
  | 'error';

export type Tone = 'neg' | 'warn' | 'info';

/** Injects the shell's and the app's styles once per document. */
export function installStyles(doc: Document, id: string, css: string): void {
  if (doc.getElementById(id)) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = PLUGIN_CSS + css;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function button(
  label: Child,
  {
    variant,
    onClick,
    ariaLabel,
    disabled,
    iconOnly,
    key,
    ...rest
  }: {
    variant?: 'primary' | 'ghost';
    onClick?: (event: Event) => void;
    ariaLabel?: string;
    disabled?: boolean;
    iconOnly?: boolean;
    /** Stable identity for focus restoration across re-renders. */
    key?: string;
    [attribute: string]: unknown;
  } = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'pl-btn',
      'data-variant': variant,
      'data-icon-only': iconOnly,
      'aria-label': ariaLabel,
      'data-key': key,
      disabled,
      onclick: onClick,
      ...(rest as Record<string, string>),
    },
    label,
  );
}

/** A toggle chip: `aria-pressed` carries the state, not colour alone. */
export function chip(
  label: Child,
  pressed: boolean,
  onClick: (event: Event) => void,
  key?: string,
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'pl-chip',
      'aria-pressed': String(pressed),
      'data-key': key,
      onclick: onClick,
    },
    label,
  );
}

/** The status pill, and the app's `role="status"` live region. */
export function pill(state: PillState, text: string): HTMLSpanElement {
  return h(
    'span',
    { class: 'pl-pill', 'data-state': state, role: 'status' },
    text,
  );
}

/** Name · context control · gap · status pill · one primary action. */
export function header({
  title,
  context,
  status,
  action,
}: {
  title: string;
  context?: Child;
  status?: Child;
  action?: Child;
}): HTMLElement {
  return h(
    'header',
    { class: 'pl-header' },
    h('h1', {}, title),
    context ? h('div', { class: 'pl-context' }, context) : undefined,
    h('span', { class: 'pl-spacer' }),
    status,
    action,
  );
}

/** One sentence and one action for a proxy-backed source. */
export function conn({
  source,
  text,
  action,
  tone,
}: {
  source: string;
  text: Child;
  action?: Child;
  tone?: 'warn';
}): HTMLElement {
  return h(
    'div',
    { class: 'pl-conn', 'data-tone': tone },
    h('b', {}, source),
    h('span', { class: 'pl-spacer' }, text),
    action,
  );
}

/** Heading, one sentence, one primary action, one secondary. */
export function empty({
  heading,
  text,
  action,
  secondary,
  extra,
}: {
  heading?: string;
  text: Child;
  action?: Child;
  secondary?: Child;
  extra?: Child;
}): HTMLElement {
  return h(
    'div',
    { class: 'pl-empty' },
    heading ? h('h2', {}, heading) : undefined,
    h('p', {}, text),
    action || secondary
      ? h('div', { class: 'pl-actions' }, action, secondary)
      : undefined,
    extra,
  );
}

/**
 * A title naming what failed, one sentence of cause, an optional body and
 * recovery action, and the raw message in a "Technical details" disclosure,
 * never in the title. `neg` banners are alerts; the title takes focus
 * programmatically (`tabindex="-1"`).
 */
export function banner({
  tone,
  title,
  text,
  body,
  action,
  details,
}: {
  tone: Tone;
  title?: string;
  text: Child;
  body?: Child;
  action?: Child;
  details?: string;
}): HTMLElement {
  return h(
    'div',
    {
      class: 'pl-banner',
      'data-tone': tone,
      role: tone === 'info' ? 'note' : 'alert',
    },
    title ? h('h3', { tabindex: '-1' }, title) : undefined,
    h('p', {}, text),
    body,
    action ? h('div', {}, action) : undefined,
    details
      ? h(
          'details',
          {},
          h('summary', {}, 'Technical details'),
          h('p', { class: 'pl-mono' }, details),
        )
      : undefined,
  );
}

/** Tab strip: `role="tablist"` with `aria-selected` on the current tab. */
export function tabs<T extends string>(
  items: { id: T; label: string; count?: string }[],
  current: T,
  onSelect: (id: T) => void,
  label: string,
): HTMLElement {
  return h(
    'nav',
    { class: 'pl-tabs', role: 'tablist', 'aria-label': label },
    items.map(item =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(item.id === current),
          'data-key': `tab-${item.id}`,
          onclick: () => onSelect(item.id),
        },
        item.label,
        item.count !== undefined
          ? h('span', { class: 'pl-count pl-num' }, item.count)
          : undefined,
      ),
    ),
  );
}

export type PanelMode = 'side' | 'drawer' | 'sheet';

/**
 * The detail container. A labelled, non-modal region beside the list at
 * ≥900px; a modal dialog (drawer or full-screen sheet) below that.
 */
export function panel(
  mode: PanelMode,
  label: string,
  ...children: Child[]
): HTMLElement {
  return h(
    'aside',
    mode === 'side'
      ? {
          class: 'pl-panel',
          'data-mode': mode,
          role: 'region',
          'aria-label': label,
        }
      : {
          class: 'pl-panel',
          'data-mode': mode,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': label,
        },
    children,
  );
}

export const panelMode = (width: number): PanelMode =>
  width >= 900 ? 'side' : width >= 560 ? 'drawer' : 'sheet';
