// @wc-ignore-file
/**
 * Cell renderers per projected Notion type, shared by the table, board, list
 * and side peek: numbers right-aligned in tabular figures, checkboxes as a
 * check or a dash with a text label, options as pills in Notion's colours.
 */
import type { Row } from '../rows.js';
import type { NotionOption } from '../sync.js';
import { h, icon } from '../ui/dom.js';
import { when } from '../ui/format.js';
import { cellValue, optionIds, type ViewColumn } from './model.js';

export const NOTION_COLOURS = new Set([
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
]);

const GLYPHS: Record<string, string> = {
  title: 'title',
  rich_text: 'text',
  number: 'number',
  checkbox: 'checkbox',
  url: 'url',
  email: 'email',
  phone_number: 'phone',
  status: 'status',
  select: 'select',
  multi_select: 'multi',
  database: 'db',
  edited: 'clock',
  people: 'person',
  date: 'date',
  relation: 'relation',
  files: 'files',
  created_time: 'clock',
  last_edited_time: 'clock',
};

export const glyphFor = (type: string) => GLYPHS[type] ?? 'info';

/** Human names for Notion types the lens does not copy. */
export const TYPE_NAMES: Record<string, string> = {
  rich_text: 'text',
  phone_number: 'phone',
  multi_select: 'multi-select',
  created_time: 'created time',
  last_edited_time: 'last edited time',
  created_by: 'created by',
  last_edited_by: 'last edited by',
  unique_id: 'ID',
};

export const typeName = (type: string) => TYPE_NAMES[type] ?? type.replaceAll('_', ' ');

export const isNumeric = (column: ViewColumn) => column.type === 'number';

export interface CellContext {
  doc: Document;
  now: number;
  locale?: string;
  /** Opens a link; the view falls back to a copyable URL when it cannot. */
  openLink: (href: string, row: Row) => void;
}

export function optionPill(
  doc: Document,
  option: NotionOption | undefined,
  id: string,
  status: boolean,
): HTMLElement {
  const colour = option && NOTION_COLOURS.has(option.color) ? option.color : 'default';

  return h(
    doc,
    'span',
    {
      class: `nt-tag${status ? ' nt-status' : ''} c-${colour}`,
      title: option ? undefined : `Option ${id} is not in the last sync’s schema`,
    },
    option?.name || (option ? 'Untitled option' : 'Unknown option'),
  );
}

const displayUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** The content of one cell; `undefined` values render as nothing. */
export function renderValue(
  ctx: CellContext,
  row: Row,
  column: ViewColumn,
  { inPeek = false }: { inPeek?: boolean } = {},
): Node | null {
  const { doc } = ctx;
  const value = cellValue(row, column);

  switch (column.type) {
    case 'title':
      return h(doc, 'span', {}, row.name);
    case 'database':
      return h(doc, 'span', { class: 'nt-dbname' }, icon(doc, 'db'), row.dataSource);
    case 'edited':
      return typeof value === 'number'
        ? doc.createTextNode(`${when(value, ctx.now, ctx.locale)}${inPeek ? ' in Notion' : ''}`)
        : null;
    case 'checkbox': {
      const yes = value === true;
      const mark = h(
        doc,
        'span',
        { class: yes ? 'nt-yes' : 'nt-no', role: 'img', 'aria-label': yes ? 'Yes' : 'No' },
        icon(doc, yes ? 'check' : 'dash'),
      );

      return inPeek ? h(doc, 'span', { class: 'nt-dbname' }, mark, yes ? 'Yes' : 'No') : mark;
    }
    case 'number':
      return typeof value === 'number'
        ? doc.createTextNode(value.toLocaleString(ctx.locale, { maximumFractionDigits: 20 }))
        : null;
    case 'status':
    case 'select':
    case 'multi_select': {
      const ids = optionIds(value);
      if (!ids.length) return null;
      const pills = ids.map(id =>
        optionPill(doc, column.options.get(id), id, column.type === 'status'),
      );

      return pills.length === 1 ? pills[0]! : h(doc, 'span', { class: 'nt-tags' }, pills);
    }
    case 'url':
    case 'email':
    case 'phone_number': {
      if (typeof value !== 'string' || !value) return null;
      // The host opens http(s) links only (`store.openExternal`), so email
      // addresses and phone numbers are selectable text, not links.
      const href =
        column.type === 'url' && /^https?:\/\//i.test(value) ? value : undefined;
      if (!href) return doc.createTextNode(value);

      return h(
        doc,
        'a',
        {
          class: 'nt-link',
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          onclick: (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            ctx.openLink(href, row);
          },
        },
        column.type === 'url' ? displayUrl(value) : value,
      );
    }
    default:
      return typeof value === 'string' || typeof value === 'number'
        ? doc.createTextNode(String(value))
        : null;
  }
}
