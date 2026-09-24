// @wc-ignore-file
/**
 * The icon sprite from mockups.html (#89): 16px line icons, stroked in
 * `currentColor`. `sprite()` is added once to the app root; `icon()` in
 * `dom.ts` references a symbol by name. Includes the Notion property-type
 * glyphs so one sprite serves the whole frame.
 */
const PATHS: Record<string, string> = {
  title: '<path d="M3 4h10M8 4v9"/>',
  text: '<path d="M3 4.5h10M3 8h10M3 11.5h6"/>',
  number: '<path d="M6.3 2.5 4.8 13.5M11.3 2.5 9.8 13.5M3 6h10.5M2.5 10H13"/>',
  checkbox: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="m5.5 8.2 1.8 1.8 3.4-3.8"/>',
  url: '<path d="M7 9a3 3 0 0 0 4.2 0l2-2A3 3 0 0 0 9 2.8l-.7.7M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l.7-.7"/>',
  status: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
  select: '<circle cx="8" cy="8" r="5.5"/><path d="m5.8 7 2.2 2.2L10.2 7"/>',
  multi: '<path d="M2.5 4.5h1.5M2.5 8h1.5M2.5 11.5h1.5M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/>',
  email: '<circle cx="8" cy="8" r="2.3"/><path d="M10.3 8v1a1.7 1.7 0 0 0 3.2 0V8a5.5 5.5 0 1 0-2.2 4.4"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/><path d="M7 12.2h2"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  db: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  sync: '<path d="M13 6A5.3 5.3 0 0 0 3.3 5.2M3 10a5.3 5.3 0 0 0 9.7.8M13 2.5V6H9.5M3 13.5V10h3.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  ext: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  alert: '<path d="M8 2.2 14.3 13.5H1.7z"/><path d="M8 6.5v3M8 11.4v.2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.6M8 5.1v.2"/>',
  table: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5V13"/>',
  board: '<rect x="2.5" y="3" width="3" height="10" rx="1"/><rect x="6.5" y="3" width="3" height="7" rx="1"/><rect x="10.5" y="3" width="3" height="5" rx="1"/>',
  list: '<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.7 4.5h.1M2.7 8h.1M2.7 11.5h.1"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  chev: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
  person: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.4 2.8-3.5 5-3.5s4.2 1.1 5 3.5"/>',
  date: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  relation: '<path d="M4 12 12 4M7 4h5v5"/>',
  files: '<path d="M9.5 2.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7z"/><path d="M9.5 2.5v3h3"/>',
  plug: '<path d="M6 2.5v3M10 2.5v3M4 5.5h8v2a4 4 0 0 1-8 0zM8 11.5v2.5"/>',
  check: '<path d="m3.5 8.5 3 3 6-6.5"/>',
  dash: '<path d="M5 8h6"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
};

export type IconName = keyof typeof PATHS;

export function sprite(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'position:absolute');
  svg.innerHTML =
    '<defs>' +
    Object.entries(PATHS)
      .map(
        ([name, body]) =>
          `<symbol id="i-${name}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`,
      )
      .join('') +
    '</defs>';

  return svg;
}
