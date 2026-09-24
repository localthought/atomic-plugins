// @wc-ignore-file
/**
 * Shared plugin chrome as plain-DOM builders (DESIGN.md §3): header row,
 * connection bar, status pill, banner, empty-state card, segmented control
 * and sheet frame. Provider-neutral: the calendar passes its own text,
 * chips and actions in. Styled by `styles.ts`.
 */
import { h, ICONS, svg, type Child } from './dom.js';

export interface PillModel {
  text: string;
  tone: 'muted' | 'accent' | 'warn' | 'neg';
  busy?: boolean;
  onClick?: () => void;
}

export function pill(doc: Document, model: PillModel): HTMLElement {
  const tone = model.tone === 'muted' ? '' : ` pill-${model.tone}`;
  const content: Child[] = [
    model.busy
      ? h(doc, 'span', { class: 'spin', 'aria-hidden': 'true' })
      : null,
    h(doc, 'span', { role: 'status' }, model.text),
  ];

  return model.onClick
    ? h(
        doc,
        'button',
        { class: `pill${tone}`, 'data-key': 'pill', onclick: model.onClick },
        ...content,
      )
    : h(doc, 'span', { class: `pill${tone}` }, ...content);
}

export function header(
  doc: Document,
  {
    title,
    chips,
    status,
    action,
  }: { title: string; chips?: Child; status?: Child; action?: Child },
): HTMLElement {
  return h(
    doc,
    'header',
    { class: 'hd' },
    h(
      doc,
      'div',
      { class: 'hd-id' },
      h(doc, 'span', { class: 'mark' }, svg(doc, ICONS.calendar)),
      h(doc, 'h1', {}, title),
    ),
    chips ? h(doc, 'div', { class: 'hd-chips' }, chips) : null,
    h(doc, 'div', { class: 'hd-act' }, status, action),
  );
}

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** Provider mark, account label, last sync, overflow menu; a 2px bar while busy. */
export function connectionBar(
  doc: Document,
  {
    provider,
    account,
    detail,
    busy,
    menu,
    menuOpen,
    onMenu,
  }: {
    provider: string;
    account?: string;
    detail?: string;
    busy?: boolean;
    menu?: MenuItem[];
    menuOpen?: boolean;
    onMenu?: (open: boolean) => void;
  },
): HTMLElement {
  const items = menu ?? [];

  return h(
    doc,
    'div',
    { class: `cbar${busy ? ' is-busy' : ''}` },
    h(doc, 'span', { class: 'gmark' }, svg(doc, ICONS.google)),
    h(
      doc,
      'span',
      { class: 'cbar-acc' },
      provider,
      account ? ' · ' : null,
      account ? h(doc, 'b', {}, account) : null,
      detail ? h(doc, 'span', { class: 'cbar-last' }, ` · ${detail}`) : null,
    ),
    items.length
      ? h(
          doc,
          'span',
          { class: 'cbar-menu' },
          h(
            doc,
            'button',
            {
              class: 'icon-btn',
              'aria-label': 'Connection menu',
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen ? 'true' : 'false',
              'data-key': 'cbar-menu',
              onclick: () => onMenu?.(!menuOpen),
            },
            svg(doc, ICONS.more),
          ),
          menuOpen
            ? h(
                doc,
                'div',
                { class: 'menu', role: 'menu' },
                ...items.map((item, i) =>
                  h(
                    doc,
                    'button',
                    {
                      role: 'menuitem',
                      'data-key': `menu-${i}`,
                      disabled: item.disabled,
                      onclick: () => {
                        onMenu?.(false);
                        item.onSelect();
                      },
                    },
                    item.label,
                    item.hint ? h(doc, 'small', {}, item.hint) : null,
                  ),
                ),
              )
            : null,
        )
      : null,
  );
}

export interface BannerModel {
  tone: 'neg' | 'warn' | 'info';
  role: 'alert' | 'status';
  title: string;
  body: string;
  details?: string;
  /** `name`: an accessible name that contains the visible label. */
  action?: { label: string; name?: string; onClick: () => void };
}

/** Cause in plain words, one recovery action, raw status behind Details. */
export function banner(doc: Document, model: BannerModel): HTMLElement {
  return h(
    doc,
    'div',
    { class: `banner b-${model.tone}`, role: model.role },
    h(
      doc,
      'span',
      { class: 'bi', 'aria-hidden': 'true' },
      model.tone === 'info' ? 'i' : '!',
    ),
    h(
      doc,
      'div',
      { class: 'bt' },
      h(doc, 'b', {}, model.title),
      h(doc, 'span', {}, model.body),
      model.details
        ? h(
            doc,
            'details',
            {},
            h(doc, 'summary', {}, 'Details'),
            h(doc, 'code', {}, model.details),
          )
        : null,
    ),
    model.action
      ? h(
          doc,
          'button',
          {
            class: `btn btn-sm${model.role === 'alert' && model.tone === 'neg' ? ' btn-primary' : ''}`,
            'data-key': `banner-${model.action.label}`,
            'aria-label': model.action.name,
            onclick: model.action.onClick,
          },
          model.action.label,
        )
      : null,
  );
}

/** Centred icon, one sentence, at most one primary button. */
export function emptyState(
  doc: Document,
  {
    title,
    text,
    muted,
    children,
  }: { title: string; text?: string; muted?: boolean; children?: Child[] },
): HTMLElement {
  return h(
    doc,
    'div',
    { class: 'center' },
    h(
      doc,
      'div',
      { class: 'card' },
      h(
        doc,
        'div',
        { class: `big-ic${muted ? ' muted-ic' : ''}` },
        svg(doc, ICONS.calendar),
      ),
      h(doc, 'h2', {}, title),
      text ? h(doc, 'p', {}, text) : null,
      ...(children ?? []),
    ),
  );
}

export function segmented<T extends string>(
  doc: Document,
  label: string,
  options: Array<{ value: T; label: string }>,
  value: T,
  onChange: (value: T) => void,
): HTMLElement {
  return h(
    doc,
    'div',
    { class: 'segs', role: 'group', 'aria-label': label },
    ...options.map(o =>
      h(
        doc,
        'button',
        {
          class: 'seg',
          'aria-pressed': o.value === value ? 'true' : 'false',
          'data-key': `seg-${o.value}`,
          onclick: () => onChange(o.value),
        },
        o.label,
      ),
    ),
  );
}

/** A modal sheet with a labelled heading and a close button. */
export function sheet(
  doc: Document,
  {
    id,
    title,
    subtitle,
    onClose,
    body,
    footer,
  }: {
    id: string;
    title: string;
    subtitle?: string;
    onClose: () => void;
    body: Child[];
    footer?: Child[];
  },
): HTMLElement {
  const heading = `${id}-title`;

  return h(
    doc,
    'div',
    {
      class: 'scrim',
      onclick: (event: Event) => {
        if (event.target === event.currentTarget) onClose();
      },
    },
    h(
      doc,
      'section',
      {
        class: 'sheet',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': heading,
        'data-sheet': id,
      },
      h(
        doc,
        'div',
        { class: 'sheet-hd' },
        h(
          doc,
          'div',
          {},
          h(doc, 'h2', { id: heading, tabindex: '-1' }, title),
          subtitle ? h(doc, 'p', {}, subtitle) : null,
        ),
        h(
          doc,
          'button',
          {
            class: 'icon-btn',
            'aria-label': 'Close',
            'data-key': `${id}-close`,
            onclick: onClose,
          },
          svg(doc, ICONS.close),
        ),
      ),
      ...body,
      footer ? h(doc, 'div', { class: 'sheet-ft' }, ...footer) : null,
    ),
  );
}
