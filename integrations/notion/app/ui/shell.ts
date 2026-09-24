// @wc-ignore-file
/**
 * The shared plugin shell (#89 DESIGN.md §4): header row (mark, name, source
 * chips, status pill, one primary action), connection bar, banners and empty
 * states. Pure render functions over plain models; no Notion specifics, so
 * they can move to a shared `pl-` kit later. Styles are in `styles.ts`.
 */
import { h, icon, type Child } from './dom.js';

export type Tone = 'ok' | 'sync' | 'warn' | 'neg' | 'muted';

export interface PillModel {
  tone: Tone;
  text: string;
}

export interface ActionModel {
  label: string;
  onClick: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: string;
  disabled?: boolean;
  /** Spinning icon, and `aria-busy`. */
  busy?: boolean;
  size?: 'sm' | 'lg';
  /** Stable key so focus survives a re-render. */
  key?: string;
}

export interface ChipModel {
  key: string;
  label: string;
  count?: number;
  icon?: string;
  pressed: boolean;
  onClick: () => void;
}

export interface SelectModel {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

export function button(doc: Document, action: ActionModel): HTMLButtonElement {
  const glyph = action.busy ? 'sync' : action.icon;

  return h(
    doc,
    'button',
    {
      type: 'button',
      class: `pl-btn is-${action.kind ?? 'primary'}${action.size ? ` is-${action.size}` : ''}`,
      disabled: action.disabled || action.busy,
      'aria-busy': action.busy ? 'true' : undefined,
      'data-key': action.key,
      onclick: () => action.onClick(),
    },
    glyph &&
      (action.busy
        ? h(doc, 'span', { class: 'pl-spin' }, icon(doc, glyph))
        : icon(doc, glyph)),
    h(doc, 'span', {}, action.label),
  );
}

/**
 * Updates the one `role=status` element in place, so assistive technology
 * announces changes (a live region replaced by a new node is not announced).
 */
export function updatePill(
  doc: Document,
  el: HTMLElement,
  pill: PillModel | undefined,
): HTMLElement {
  el.hidden = !pill;
  if (!pill) {
    el.replaceChildren();

    return el;
  }

  el.className = `pl-pill${pill.tone === 'ok' || pill.tone === 'muted' ? '' : ` is-${pill.tone}`}`;
  const glyph =
    pill.tone === 'ok'
      ? h(doc, 'span', { class: 'pl-dot', 'aria-hidden': 'true' })
      : pill.tone === 'sync'
        ? h(doc, 'span', { class: 'pl-spin' }, icon(doc, 'sync'))
        : pill.tone === 'muted'
          ? null
          : icon(doc, 'alert');
  if (el.textContent !== pill.text || el.childElementCount !== (glyph ? 2 : 1))
    el.replaceChildren(...(glyph ? [glyph] : []), h(doc, 'span', {}, pill.text));

  return el;
}

export function pillElement(doc: Document): HTMLElement {
  return h(doc, 'span', { role: 'status', class: 'pl-pill', hidden: true });
}

export interface HeaderModel {
  mark: string;
  name: string;
  chips?: ChipModel[];
  select?: SelectModel;
  /** The persistent `role=status` element from `pillElement`. */
  pill?: HTMLElement;
  action?: ActionModel;
}

export function renderHeader(doc: Document, model: HeaderModel): HTMLElement {
  const chips = model.chips?.length
    ? h(
        doc,
        'div',
        { class: 'pl-chips', role: 'group', 'aria-label': 'Databases' },
        model.chips.map(chip =>
          h(
            doc,
            'button',
            {
              type: 'button',
              class: 'pl-chip',
              'aria-pressed': chip.pressed ? 'true' : 'false',
              'data-key': `chip:${chip.key}`,
              onclick: () => chip.onClick(),
            },
            chip.icon && icon(doc, chip.icon),
            chip.label,
            chip.count !== undefined &&
              h(doc, 'span', { class: 'pl-count' }, chip.count),
          ),
        ),
      )
    : h(doc, 'div', { class: 'pl-spacer' });

  const select =
    model.select &&
    h(
      doc,
      'label',
      { class: 'pl-select' },
      h(doc, 'span', { class: 'pl-sr' }, model.select.label),
      h(
        doc,
        'select',
        {
          'data-key': 'scope-select',
          onchange: (event: Event) =>
            model.select!.onChange((event.target as HTMLSelectElement).value),
        },
        model.select.options.map(o =>
          h(
            doc,
            'option',
            { value: o.value, selected: o.value === model.select!.value },
            o.label,
          ),
        ),
      ),
      icon(doc, 'chev'),
    );

  return h(
    doc,
    'header',
    { class: 'pl-header' },
    h(
      doc,
      'div',
      { class: 'pl-brand' },
      h(doc, 'span', { class: 'pl-mark', 'aria-hidden': 'true' }, model.mark),
      h(doc, 'h1', { class: 'pl-name', style: 'margin:0' }, model.name),
    ),
    chips,
    h(
      doc,
      'div',
      { class: 'pl-actions' },
      model.pill,
      model.action && button(doc, model.action),
    ),
    select,
  );
}

export interface MenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled, as a tooltip. */
  title?: string;
}

/** A "⋯" button with a small menu. Esc and a click outside close it. */
export function renderMenu(
  doc: Document,
  label: string,
  items: MenuItem[],
  open: boolean,
  setOpen: (open: boolean) => void,
): HTMLElement {
  const toggle = h(
    doc,
    'button',
    {
      type: 'button',
      class: 'pl-icon-btn',
      'aria-label': label,
      'aria-haspopup': 'menu',
      'aria-expanded': open ? 'true' : 'false',
      'data-key': `menu:${label}`,
      onclick: () => setOpen(!open),
    },
    icon(doc, 'more'),
  );
  const list =
    open &&
    h(
      doc,
      'div',
      {
        class: 'pl-menu',
        role: 'menu',
        onkeydown: (event: Event) => {
          if ((event as KeyboardEvent).key === 'Escape') setOpen(false);
        },
      },
      items.map(item =>
        h(
          doc,
          'button',
          {
            type: 'button',
            role: 'menuitem',
            disabled: item.disabled,
            title: item.title,
            onclick: () => {
              setOpen(false);
              item.onClick();
            },
          },
          item.icon && icon(doc, item.icon),
          item.label,
        ),
      ),
    );

  return h(doc, 'div', { class: 'pl-menu-wrap' }, toggle, list);
}

export function renderConnbar(
  doc: Document,
  items: (Child | Child[])[],
  trailing: Child[],
): HTMLElement {
  const parts: Child[] = [];

  items.forEach((item, i) => {
    if (i) parts.push(h(doc, 'span', { class: 'pl-sep', 'aria-hidden': 'true' }, '·'));
    parts.push(h(doc, 'span', { class: 'pl-cb-item' }, ...[item].flat()));
  });

  return h(
    doc,
    'div',
    { class: 'pl-connbar' },
    parts,
    h(doc, 'span', { class: 'pl-spacer' }),
    trailing,
  );
}

export interface BannerModel {
  tone: 'neg' | 'warn';
  title: string;
  text: Child | Child[];
  action?: ActionModel;
  /** Status, path and time for bug reports, behind a disclosure. */
  technical?: string;
  /** `role=alert`: only when the banner appears in answer to an action. */
  alert?: boolean;
}

export function renderBanner(doc: Document, model: BannerModel): HTMLElement {
  return h(
    doc,
    'div',
    {
      class: `pl-banner${model.tone === 'warn' ? ' is-warn' : ''}`,
      role: model.alert ? 'alert' : undefined,
    },
    icon(doc, 'alert'),
    h(
      doc,
      'div',
      {},
      h(doc, 'p', { class: 'pl-banner-t' }, model.title),
      h(doc, 'p', {}, ...[model.text].flat()),
      model.technical &&
        h(
          doc,
          'details',
          {},
          h(doc, 'summary', {}, 'Technical details'),
          h(doc, 'pre', {}, model.technical),
        ),
    ),
    model.action ? button(doc, model.action) : h(doc, 'span'),
  );
}

export interface EmptyModel {
  glyph: Node;
  title: string;
  text: Child | Child[];
  facts?: { icon: string; text: Child | Child[] }[];
  action?: ActionModel;
  secondary?: Child | Child[];
  steps?: (Child | Child[])[];
}

export function renderEmpty(doc: Document, model: EmptyModel): HTMLElement {
  return h(
    doc,
    'div',
    { class: 'pl-empty' },
    model.glyph,
    h(doc, 'h2', {}, model.title),
    h(doc, 'p', {}, ...[model.text].flat()),
    model.facts?.length &&
      h(
        doc,
        'ul',
        { class: 'pl-facts' },
        model.facts.map(f =>
          h(doc, 'li', {}, icon(doc, f.icon), h(doc, 'span', {}, ...[f.text].flat())),
        ),
      ),
    model.action && button(doc, { size: 'lg', ...model.action }),
    model.steps?.length &&
      h(
        doc,
        'ol',
        { class: 'pl-steps' },
        model.steps.map(s => h(doc, 'li', {}, ...[s].flat())),
      ),
    model.secondary !== undefined &&
      h(doc, 'p', { class: 'pl-secondary' }, ...[model.secondary].flat()),
  );
}

export const emptyGlyph = (doc: Document, name: string) =>
  h(doc, 'span', { class: 'pl-empty-glyph' }, icon(doc, name));

/**
 * Opens `url` in a new tab. A frame sandboxed without `allow-popups` (the
 * host's app frame at this pin) gets `null` back; the caller then shows the
 * URL as selectable text with a copy button (`renderCopy`).
 */
export function openExternal(win: Window, url: string): boolean {
  try {
    const opened = win.open(url, '_blank');
    if (!opened) return false;
    opened.opener = null;

    return true;
  } catch {
    return false;
  }
}

/** A selectable URL with a Copy button, for when a link cannot open. */
export function renderCopy(doc: Document, text: string, note: string): HTMLElement {
  const code = h(doc, 'code', {}, text);
  const status = h(doc, 'span', { class: 'pl-sr', role: 'status' });

  return h(
    doc,
    'div',
    { class: 'pl-copy' },
    code,
    h(
      doc,
      'button',
      {
        type: 'button',
        class: 'pl-btn is-secondary is-sm',
        onclick: async () => {
          status.textContent = (await copyText(doc, text, code))
            ? 'Copied'
            : 'Selected: press Ctrl+C or ⌘C to copy';
        },
      },
      'Copy',
    ),
    h(doc, 'span', { class: 'pl-sr' }, note),
    status,
  );
}

async function copyText(doc: Document, text: string, el: Element): Promise<boolean> {
  try {
    await doc.defaultView?.navigator.clipboard.writeText(text);

    return true;
  } catch {
    const selection = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);

    try {
      return doc.execCommand('copy');
    } catch {
      return false;
    }
  }
}
