// @wc-ignore-file
/**
 * The plugin family's shared pieces (#89 §4): header row, status pill,
 * banner, empty state, centred panel. Shared-kit candidates: they take
 * text and callbacks, and know nothing about Clockify or timesheets.
 */
import { icon, type Child, type H, type IconName } from './dom.js';

/** The Money design's `data-state` names; `Offline` maps to `paused`. */
export type PillState =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'paused'
  | 'reauth'
  | 'error';

export const pill = (h: H, state: PillState, text: string) =>
  h('span', { class: 'pill', 'data-state': state }, text);

export interface HeaderProps {
  /** Visible title. */
  title: string;
  /** Prefix read before the title by screen readers only. */
  srPrefix?: string;
  mark: IconName;
  chip?: { letter: string; text: string } | undefined;
  pill: HTMLElement;
  action?: Child;
}

export function header(h: H, p: HeaderProps): HTMLElement {
  const doc = h.doc;

  return h(
    'header',
    { class: 'hdr' },
    h('span', { class: 'mark' }, icon(doc, p.mark)),
    h(
      'h1',
      null,
      p.srPrefix ? h('span', { class: 'sr' }, p.srPrefix) : null,
      p.title,
    ),
    p.chip
      ? h(
          'span',
          { class: 'chip' },
          h('span', { class: 'src', 'aria-hidden': 'true' }, p.chip.letter),
          p.chip.text,
        )
      : null,
    h('span', { class: 'spacer' }),
    p.pill,
    p.action,
  );
}

export interface ButtonProps {
  variant?: 'primary' | 'sec' | 'ghost' | 'danger';
  icon?: IconName;
  /** Icon-only: the text becomes the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
  key?: string;
  onClick?: () => void;
  label?: string;
}

export function button(h: H, text: string, p: ButtonProps = {}) {
  const doc = h.doc;
  const variant = p.variant && p.variant !== 'primary' ? ` ${p.variant}` : '';
  const node = h(
    'button',
    {
      type: 'button',
      class: `btn${variant}${p.iconOnly ? ' icon' : ''}`,
      disabled: !!p.disabled,
      'data-k': p.key,
      'aria-label': p.iconOnly ? text : p.label,
    },
    p.icon ? icon(doc, p.icon) : null,
    p.iconOnly ? null : text,
  );
  if (p.onClick) node.addEventListener('click', p.onClick);

  return node;
}

export interface BannerProps {
  tone: 'warn' | 'neg' | 'info';
  icon: IconName;
  /** Bold lead, then the rest of the sentence. */
  lead: string;
  text?: string;
  action?: Child;
  details?: { summary: string; text: string };
  /** `alert` for failures; none for notes the status region already says. */
  role?: 'alert';
}

export function banner(h: H, p: BannerProps): HTMLElement {
  const doc = h.doc;

  return h(
    'div',
    { class: `banner ${p.tone}`, role: p.role },
    icon(doc, p.icon),
    h('p', null, h('strong', null, p.lead), p.text ? ` ${p.text}` : null),
    p.action ?? h('span'),
    p.details
      ? h(
          'details',
          null,
          h('summary', null, p.details.summary),
          h('code', null, p.details.text),
        )
      : null,
  );
}

export function emptyState(
  h: H,
  p: { lead: string; text?: string; actions: Child[]; link?: Child },
): HTMLElement {
  const doc = h.doc;

  return h(
    'div',
    { class: 'empty' },
    icon(doc, 'empty'),
    h('p', null, h('strong', null, p.lead)),
    p.text
      ? h('p', { class: 'muted', style: 'font-size: 13px' }, p.text)
      : null,
    h('div', { class: 'row', style: 'justify-content: center' }, ...p.actions),
    p.link ?? null,
  );
}

export const panel = (h: H, title: string, ...children: Child[]) =>
  h(
    'div',
    { class: 'centre' },
    h('div', { class: 'panel' }, h('h2', null, title), ...children),
  );

/**
 * An external link. The frame has no popup rights, so with the host's
 * `openExternal` (passed as `open`) it is a button that asks the host;
 * without it, a plain link that an older host may block.
 */
export const extLink = (
  h: H,
  href: string,
  text: string,
  cls = 'link',
  open?: (url: string) => void,
) => {
  const doc = h.doc;
  const ext = cls.includes('btn') ? icon(doc, 'ext') : null;

  if (open) {
    const node = h(
      'button',
      { type: 'button', class: cls, 'data-k': `open:${href}` },
      text,
      ext,
    );
    node.addEventListener('click', () => open(href));

    return node;
  }

  return h(
    'a',
    { class: cls, href, target: '_blank', rel: 'noopener noreferrer' },
    text,
    ext,
  );
};
