// @wc-ignore-file
/**
 * A tiny plain-DOM builder for the timesheets views. Shared-kit candidate
 * (#89 §4): nothing here knows about Clockify.
 */

export type Child = Node | string | null | undefined | false;

export interface Attrs {
  [name: string]: string | number | boolean | undefined | null;
}

export interface H {
  <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Attrs | null,
    ...children: (Child | Child[])[]
  ): HTMLElementTagNameMap[K];
  readonly doc: Document;
}

/** `h('button', { class: 'btn', disabled: true }, 'Sync now')`. Attributes
 * whose value is `false`, `null` or `undefined` are left off. */
export function builder(doc: Document): H {
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Attrs | null,
    ...children: (Child | Child[])[]
  ) => {
    const node = doc.createElement(tag);

    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (value === false || value === null || value === undefined) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }

    append(node, children);

    return node;
  };

  return Object.assign(h, { doc });
}

export function append(node: Node, children: (Child | Child[])[]) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(
      typeof child === 'string'
        ? node.ownerDocument!.createTextNode(child)
        : child,
    );
  }
}

const SVG = 'http://www.w3.org/2000/svg';

/** Icon paths from design/mockups.html, drawn at 24×24 with a stroke. */
export const ICONS = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  left: '<path d="M14.5 6 8.5 12l6 6"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4.2M12 17.2v.1"/>',
  err: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16v.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  minus: '<path d="M6 12h12"/>',
  ext: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v5H5V6h5"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0Z"/><path d="M12 16v5"/>',
  empty:
    '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 2.4"/><path d="M12 8v4"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** A decorative stroke icon (`aria-hidden`). */
export function icon(doc: Document, name: IconName, extra = ''): SVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', `i${extra ? ` ${extra}` : ''}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  // Static markup from the table above, never data.
  svg.innerHTML = ICONS[name];

  return svg;
}
