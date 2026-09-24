// @wc-ignore-file
/**
 * The shared #89 chrome as plain-DOM builders (see ui/css.ts for the
 * styles and ui/dom.ts for `h` and the icons). Nothing here is
 * issue-specific; `../views.ts` composes these for the issue tracker.
 */
import { h, icon, type Attrs, type Child, type IconName } from './dom.js';

export type PillState =
  | 'idle'
  | 'synced'
  | 'syncing'
  | 'paused'
  | 'reauth'
  | 'error';

const PILL_ICON: Record<PillState, IconName> = {
  idle: 'idle',
  synced: 'synced',
  syncing: 'syncing',
  paused: 'paused',
  reauth: 'reauth',
  error: 'error',
};

/**
 * The sync pill. Each state has its own icon shape as well as colour. It is
 * the view's one `role="status"`; pass `onclick` to make it a button (for
 * the "Sync failed" popover).
 */
export function pill(
  state: PillState,
  text: string,
  onclick?: (event: Event) => void,
): HTMLElement {
  const content = [icon(PILL_ICON[state], 12), h('span', null, text)];

  return onclick
    ? h(
        'button',
        {
          type: 'button',
          class: 'pl-pill',
          'data-state': state,
          'aria-haspopup': 'dialog',
          onclick,
        },
        h('span', { role: 'status', class: 'pill-status' }, content),
      )
    : h(
        'span',
        { class: 'pl-pill', 'data-state': state, role: 'status' },
        content,
      );
}

/** Plugin mark, name (the page's h1), then whatever the app adds. */
export function header(name: Child, ...rest: Child[]): HTMLElement {
  return h(
    'header',
    { class: 'pl-header' },
    h('span', { class: 'pl-mark', 'aria-hidden': 'true' }, icon('mark')),
    h('h1', { class: 'pl-name' }, name),
    ...rest,
  );
}

/** The source chip: provider in bold, scope in mono. */
export function sourceChip(provider: string, scope: string): HTMLElement {
  return h(
    'span',
    { class: 'src-chip' },
    h('b', null, provider),
    h('span', { class: 'mono' }, scope),
  );
}

/**
 * The connection bar under the header. `progress` draws the line along its
 * bottom edge: a fraction from 0 to 1, or `true` for indeterminate.
 */
export function connectionBar(
  parts: Child[],
  actions: Child[] = [],
  progress?: number | true,
): HTMLElement {
  const items: Child[] = [];
  parts
    .filter(p => p !== undefined && p !== null && p !== false && p !== '')
    .forEach((part, i) => {
      if (i)
        items.push(h('span', { class: 'dot-sep', 'aria-hidden': 'true' }, '·'));
      items.push(...(Array.isArray(part) ? part : [part]));
    });
  const bar = h(
    'div',
    { class: 'pl-conn' },
    items,
    h('span', { class: 'spacer' }),
    ...actions,
  );

  if (progress !== undefined) {
    const line = h('span', {
      class: `progress${progress === true ? ' indeterminate' : ''}`,
      'aria-hidden': 'true',
    });
    if (progress !== true)
      line.style.setProperty('--p', `${Math.round(progress * 100)}%`);
    bar.append(line);
  }

  return bar;
}

export type Tone = 'neg' | 'warn' | 'info';

export interface BannerSpec {
  tone: Tone;
  icon: IconName;
  /** Bold lead sentence. */
  title: string;
  text?: Child;
  actions?: HTMLElement[];
  /** Raw message, behind a "Details" disclosure. */
  details?: string;
  /** Only a banner that a sync raised just now is an alert. */
  alert?: boolean;
}

/** An inline banner: cause in one sentence, one way out, optional details. */
export function banner(spec: BannerSpec): HTMLElement {
  const box = h(
    'div',
    {
      class: 'pl-banner',
      'data-tone': spec.tone,
      ...(spec.alert ? { role: 'alert' } : {}),
    },
    h('span', { class: 'b-icon' }, icon(spec.icon)),
    h('p', { class: 'b-text' }, h('b', null, spec.title), ' ', spec.text),
    spec.actions?.length
      ? h('div', { class: 'b-actions' }, spec.actions)
      : null,
  );
  if (!spec.details) return box;

  return h(
    'div',
    { class: 'banner-wrap' },
    box,
    h(
      'details',
      { class: 'b-details' },
      h('summary', null, 'Details'),
      h('code', null, spec.details),
    ),
  );
}

/** Centred icon, one sentence (bold lead plus detail), one button. */
export function empty(
  iconName: IconName,
  lead: string,
  detail: string,
  action?: HTMLElement,
  tall = false,
): HTMLElement {
  return h(
    'div',
    { class: `pl-empty${tall ? ' tall' : ''}` },
    h('span', { class: 'e-icon', 'aria-hidden': 'true' }, icon(iconName, 24)),
    h('p', null, h('b', null, lead), detail),
    action ?? null,
  );
}

export type ButtonKind = 'primary' | 'ghost' | 'danger' | '';

export function button(
  label: Child,
  onclick: (event: Event) => void,
  {
    kind = '',
    sm = false,
    iconName,
    ...attrs
  }: {
    kind?: ButtonKind;
    sm?: boolean;
    iconName?: IconName;
  } & Attrs = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: ['btn', kind, sm ? 'sm' : ''].filter(Boolean).join(' '),
      onclick,
      ...attrs,
    },
    iconName ? icon(iconName, 14) : null,
    Array.isArray(label) ? label : h('span', null, label),
  );
}

export function iconButton(
  name: IconName,
  label: string,
  onclick: (event: Event) => void,
  { sm = false, ...attrs }: { sm?: boolean } & Attrs = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: `icon-btn${sm ? ' sm' : ''}`,
      'aria-label': label,
      title: label,
      onclick,
      ...attrs,
    },
    icon(name, sm ? 14 : 16),
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: Child;
  iconName?: IconName;
  /** Accessible name when `label` is visually hidden. */
  title?: string;
}

/**
 * A segmented control. `mode: 'pressed'` is a toolbar group of toggle
 * buttons; `'radio'` is a radiogroup (the detail's status control).
 */
export function segmented<T extends string>(
  label: string,
  options: SegmentOption<T>[],
  value: T | undefined,
  onchange: (value: T) => void,
  { mode = 'pressed', disabled = false, cls = '' } = {},
): HTMLElement {
  const group = h('div', {
    class: `seg ${cls}`.trim(),
    role: mode === 'radio' ? 'radiogroup' : 'group',
    'aria-label': label,
  });

  for (const option of options) {
    const on = option.value === value;
    group.append(
      h(
        'button',
        {
          type: 'button',
          ...(mode === 'radio'
            ? {
                role: 'radio',
                'aria-checked': String(on),
                tabindex: on ? 0 : -1,
              }
            : { 'aria-pressed': String(on) }),
          ...(option.title
            ? { 'aria-label': option.title, title: option.title }
            : {}),
          'data-value': option.value,
          disabled,
          onclick: () => onchange(option.value),
        },
        option.iconName ? icon(option.iconName, 14) : null,
        option.label,
      ),
    );
  }

  if (mode === 'radio')
    group.addEventListener('keydown', event => {
      const e = event as KeyboardEvent;
      const step =
        e.key === 'ArrowRight' || e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : 0;
      if (!step) return;
      e.preventDefault();
      const at = Math.max(
        0,
        options.findIndex(o => o.value === value),
      );
      const next = options[(at + step + options.length) % options.length];
      onchange(next.value);
    });

  return group;
}

/** Search field with the `/` hint; returns the label and its input. */
export function searchField(
  label: string,
  value: string,
  oninput: (value: string) => void,
  wide = false,
): { field: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    type: 'search',
    placeholder: label,
    'aria-label': label,
    autocomplete: 'off',
    oninput: event => oninput((event.target as HTMLInputElement).value),
  });
  input.value = value;

  return {
    input,
    field: h(
      'label',
      { class: `search${wide ? ' wide' : ''}` },
      icon('search', 14),
      input,
      h('kbd', { 'aria-hidden': 'true' }, '/'),
    ),
  };
}

/**
 * A label chip: surface fill and body text, with the provider's colour
 * only as an 8px dot, so contrast never depends on an arbitrary colour.
 */
export function chip(name: string, color?: string): HTMLElement {
  const dot = h('i', { 'aria-hidden': 'true' });
  if (color && /^#[0-9a-f]{6}$/i.test(color)) dot.style.background = color;

  return h('span', { class: 'chip' }, dot, name);
}

export type Glyph = 'todo' | 'doing' | 'done';

/** Ring, half ring, filled check: status readable without colour. */
export function statusGlyph(status: Glyph, size = 14): SVGSVGElement {
  return icon(status, size, `glyph g-${status}`);
}

/** A polite live region for "Moved #42 to Done" and the like. */
export function liveRegion(): {
  region: HTMLElement;
  say(text: string): void;
} {
  const node = h('div', { class: 'sr', 'aria-live': 'polite' });

  return {
    region: node,
    say(text: string) {
      // Re-set so the same message twice is announced twice.
      node.textContent = '';
      setTimeout(() => {
        node.textContent = text;
      }, 30);
    },
  };
}
