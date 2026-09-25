// @wc-ignore-file
/**
 * Event detail and edit (DESIGN.md §5.9): a drawer at 720px and wider, a
 * full-screen sheet below. View mode shows the time in the viewer's zone
 * (and the event's own offset when it differs). Edit mode offers exactly the
 * fields the adapter maps — title, all day, start, end, location,
 * description — and saves locally: nothing is sent until it is reviewed.
 */
import type { Projection } from '../adapter.js';
import { changeLine, when, type Ctx } from './context.js';
import type { CalEvent } from './events.js';
import { h, ICONS, svg } from './ui/dom.js';
import {
  addDays,
  hhmm,
  isDate,
  offsetLabel,
  parseHhmm,
  toDateTime,
  wall,
} from './time.js';

const GOOGLE_ONLY =
  'Guests, reminders and video links are edited in Google Calendar.';

function frame(
  ctx: Ctx,
  event: CalEvent,
  onClose: () => void,
  narrow: boolean,
  ...body: Array<Node | null>
): HTMLElement {
  const { doc } = ctx;

  return h(
    doc,
    'section',
    {
      class: 'drawer',
      role: 'dialog',
      'aria-modal': narrow ? 'true' : undefined,
      'aria-labelledby': 'drawer-title',
    },
    h(
      doc,
      'div',
      { class: 'dr-hd' },
      h(doc, 'span', {
        class: 'sw',
        style: `--c:${event.calendar.color}`,
        'aria-hidden': 'true',
      }),
      event.calendar.name,
      h(
        doc,
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Close',
          'data-key': 'drawer-close',
          onclick: onClose,
        },
        svg(doc, ICONS.close),
      ),
    ),
    ...body,
  );
}

export function detail(
  ctx: Ctx,
  event: CalEvent,
  {
    narrow,
    onClose,
    onEdit,
    onReview,
    onConflicts,
    onOpenLink,
  }: {
    narrow: boolean;
    onClose: () => void;
    onEdit: () => void;
    onReview: () => void;
    onConflicts: () => void;
    /** Present when the event has a Google link and the host can open it. */
    onOpenLink?: () => void;
  },
): HTMLElement {
  const { doc } = ctx;
  const w = when(event, ctx.zone);
  const change = event.pending ? changeLine(event, ctx.zone) : undefined;
  const rows: Array<[string, Node[]]> = [
    [
      'When',
      [
        h(doc, 'span', {}, w.day),
        w.time ? h(doc, 'b', {}, w.time) : null,
        w.own ? h(doc, 'span', { class: 'muted' }, w.own) : null,
      ].filter((n): n is HTMLElement => !!n),
    ],
  ];
  if (event.location)
    rows.push(['Where', [doc.createTextNode(event.location)]]);
  if (event.description)
    rows.push(['Notes', [doc.createTextNode(event.description)]]);

  return frame(
    ctx,
    event,
    onClose,
    narrow,
    h(
      doc,
      'h2',
      { id: 'drawer-title', tabindex: '-1' },
      event.title || '(untitled)',
    ),
    event.pending
      ? h(
          doc,
          'div',
          { class: 'saved', role: 'status' },
          h(doc, 'span', { class: 'dot-accent', 'aria-hidden': 'true' }),
          h(
            doc,
            'div',
            {},
            h(doc, 'b', {}, 'Saved here · not sent to Google yet'),
            change ? h(doc, 'span', {}, change) : null,
          ),
          h(
            doc,
            'button',
            {
              class: 'btn btn-primary btn-sm',
              'data-key': 'drawer-review',
              onclick: onReview,
            },
            'Review changes',
          ),
        )
      : null,
    event.conflict
      ? h(
          doc,
          'div',
          { class: 'conflict-note' },
          h(doc, 'span', {}, 'Changed here and in Google since the last sync.'),
          h(
            doc,
            'button',
            {
              class: 'btn btn-sm',
              'data-key': 'drawer-conflicts',
              onclick: onConflicts,
            },
            'Decide',
          ),
        )
      : null,
    h(
      doc,
      'dl',
      { class: 'dr-f' },
      ...rows.map(([label, value]) =>
        h(doc, 'div', {}, h(doc, 'dt', {}, label), h(doc, 'dd', {}, ...value)),
      ),
    ),
    h(doc, 'p', { class: 'dr-hint' }, GOOGLE_ONLY),
    h(
      doc,
      'div',
      { class: 'dr-ft' },
      onOpenLink
        ? h(
            doc,
            'button',
            {
              class: 'btn btn-ghost',
              'data-key': 'drawer-open-google',
              onclick: onOpenLink,
            },
            'Open in Google Calendar ↗',
          )
        : null,
      event.readOnly
        ? h(
            doc,
            'span',
            { class: 'fine' },
            event.id
              ? 'This calendar is read-only for you: edit this event in Google Calendar.'
              : 'Made in this table: it is not sent to Google (creating events isn’t supported).',
          )
        : onOpenLink
          ? null
          : h(doc, 'span', {}),
      event.readOnly
        ? null
        : h(
            doc,
            'button',
            {
              class: 'btn btn-primary',
              'data-key': 'drawer-edit',
              onclick: onEdit,
            },
            'Edit',
          ),
    ),
  );
}

export interface Draft {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
}

export function draftOf(event: Projection, zone: string): Draft {
  if (event.allDay)
    return {
      title: event.title,
      allDay: true,
      startDate: event.start,
      startTime: '09:00',
      // The form shows the last day; storage keeps Google's exclusive end.
      endDate: addDays(event.end, -1),
      endTime: '10:00',
      location: event.location,
      description: event.description,
    };
  const s = wall(Date.parse(event.start), zone);
  const e = wall(Date.parse(event.end), zone);

  return {
    title: event.title,
    allDay: false,
    startDate: s.date,
    startTime: hhmm(s.minutes),
    endDate: e.date,
    endTime: hhmm(e.minutes),
    location: event.location,
    description: event.description,
  };
}

/**
 * The stored value for a draft, or the problems with it. Mirrors
 * `validate()` in adapter.ts, in the words the form uses.
 */
export function projectionOf(
  draft: Draft,
  zone: string,
): {
  value?: Projection;
  errors: Partial<Record<'title' | 'end' | 'start', string>>;
} {
  const errors: Partial<Record<'title' | 'end' | 'start', string>> = {};
  if (!draft.title.trim()) errors.title = 'Add a title';
  if (!isDate(draft.startDate)) errors.start = 'Enter a start date';
  if (!isDate(draft.endDate)) errors.end = 'Enter an end date';
  let start = '';
  let end = '';

  if (!errors.start && !errors.end) {
    if (draft.allDay) {
      start = draft.startDate;
      end = addDays(draft.endDate, 1);
      if (end <= start) errors.end = 'End must be after start';
    } else {
      const sm = parseHhmm(draft.startTime);
      const em = parseHhmm(draft.endTime);
      if (sm === undefined) errors.start = 'Enter a start time';
      if (em === undefined) errors.end = 'Enter an end time';

      if (sm !== undefined && em !== undefined) {
        start = toDateTime(draft.startDate, sm, zone);
        end = toDateTime(draft.endDate, em, zone);
        if (Date.parse(end) <= Date.parse(start))
          errors.end = 'End must be after start';
      }
    }
  }

  if (Object.keys(errors).length) return { errors };

  return {
    value: {
      title: draft.title,
      description: draft.description,
      location: draft.location,
      start,
      end,
      allDay: draft.allDay,
    },
    errors,
  };
}

/** Edit mode. Keeps its own draft; re-rendered only by itself. */
export function editor(
  ctx: Ctx,
  event: CalEvent,
  {
    narrow,
    onClose,
    onCancel,
    onSave,
  }: {
    narrow: boolean;
    onClose: () => void;
    onCancel: () => void;
    onSave: (value: Projection) => Promise<void>;
  },
): HTMLElement {
  const { doc, zone } = ctx;
  const draft = draftOf(event, zone);
  let touched = false;
  let saving = false;
  let failure: string | undefined;

  const container = frame(ctx, event, onClose, narrow);
  const body = h(doc, 'div', { class: 'form' });
  container.append(body);

  const input = (
    key: keyof Draft,
    attrs: Record<string, string | boolean | undefined>,
  ) =>
    h(doc, 'input', {
      ...attrs,
      value: String(draft[key]),
      'data-key': `f-${key}`,
      oninput: (e: Event) => {
        (draft as unknown as Record<string, string>)[key] = (
          e.target as HTMLInputElement
        ).value;
        touched = true;
        paintErrors();
      },
    });

  const title = input('title', { type: 'text', id: 'f-title' });
  const allDay = h(doc, 'input', {
    type: 'checkbox',
    role: 'switch',
    checked: draft.allDay,
    'data-key': 'f-allDay',
    onchange: (e: Event) => {
      draft.allDay = (e.target as HTMLInputElement).checked;
      touched = true;
      paint();
    },
  });
  const startDate = input('startDate', {
    type: 'date',
    'aria-label': 'Start date',
  });
  const startTime = input('startTime', {
    type: 'time',
    class: 't',
    'aria-label': 'Start time',
  });
  const endDate = input('endDate', { type: 'date', 'aria-label': 'End date' });
  const endTime = input('endTime', {
    type: 'time',
    class: 't',
    'aria-label': 'End time',
  });
  const location = input('location', { type: 'text', id: 'f-location' });
  const description = h(doc, 'textarea', {
    id: 'f-description',
    rows: 3,
    'data-key': 'f-description',
    oninput: (e: Event) => {
      draft.description = (e.target as HTMLTextAreaElement).value;
    },
  });
  description.value = draft.description;
  const titleError = h(doc, 'p', {
    class: 'err',
    id: 'err-title',
    role: 'alert',
  });
  const startError = h(doc, 'p', {
    class: 'err',
    id: 'err-start',
    role: 'alert',
  });
  const endError = h(doc, 'p', { class: 'err', id: 'err-end', role: 'alert' });
  const saveError = h(doc, 'p', { class: 'err', role: 'alert' });
  const save = h(
    doc,
    'button',
    {
      class: 'btn btn-primary',
      'data-key': 'drawer-save',
      onclick: async () => {
        touched = true;
        const { value } = projectionOf(draft, zone);
        paintErrors();
        if (!value || saving) return;
        saving = true;
        save.setAttribute('disabled', '');

        try {
          await onSave(value);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          saving = false;
          save.removeAttribute('disabled');
          paintErrors();
        }
      },
    },
    'Save here',
  );

  const setError = (
    node: HTMLElement,
    inputs: HTMLInputElement[],
    text: string | undefined,
  ) => {
    node.textContent = text ?? '';
    node.hidden = !text;

    for (const i of inputs) {
      i.classList.toggle('is-bad', !!text);
      if (text) i.setAttribute('aria-invalid', 'true');
      else i.removeAttribute('aria-invalid');
    }
  };

  function paintErrors() {
    const { errors } = projectionOf(draft, zone);
    const show = touched ? errors : {};
    setError(titleError, [title], show.title);
    setError(startError, [startDate, startTime], show.start);
    setError(endError, draft.allDay ? [endDate] : [endDate, endTime], show.end);

    // The time inputs do not count while all day is on.
    if (draft.allDay) {
      startTime.classList.remove('is-bad');
      endTime.classList.remove('is-bad');
    }

    setError(saveError, [], failure);
    if (Object.keys(errors).length && touched)
      save.setAttribute('disabled', '');
    else if (!saving) save.removeAttribute('disabled');
  }

  function paint() {
    const zoneLabel = `${zone.split('/').at(-1)?.replace(/_/g, ' ')}, ${offsetLabel(ctx.now, zone)}`;
    const pair = (
      label: string,
      date: HTMLInputElement,
      time: HTMLInputElement,
    ) =>
      h(
        doc,
        'div',
        {
          class: `fld-2${draft.allDay ? ' all-day' : ''}`,
          role: 'group',
          'aria-label': label,
        },
        h(doc, 'span', {}, label),
        date,
        draft.allDay ? null : time,
      );

    body.replaceChildren(
      h(
        doc,
        'h2',
        { id: 'drawer-title', class: 'sr-only', tabindex: '-1' },
        `Edit ${event.title}`,
      ),
      h(doc, 'label', { class: 'fld', for: 'f-title' }, 'Title', title),
      titleError,
      h(doc, 'label', { class: 'sw-row' }, allDay, 'All day'),
      pair('Starts', startDate, startTime),
      startError,
      pair(draft.allDay ? 'Ends (last day)' : 'Ends', endDate, endTime),
      endError,
      h(
        doc,
        'label',
        { class: 'fld', for: 'f-location' },
        'Location',
        location,
      ),
      h(
        doc,
        'label',
        { class: 'fld', for: 'f-description' },
        'Description',
        description,
      ),
      h(
        doc,
        'p',
        { class: 'dr-hint' },
        draft.allDay
          ? GOOGLE_ONLY
          : `Times are in your zone (${zoneLabel}). ${GOOGLE_ONLY}`,
      ),
      saveError,
      h(
        doc,
        'div',
        { class: 'dr-ft' },
        h(
          doc,
          'button',
          {
            class: 'btn btn-ghost',
            'data-key': 'drawer-cancel',
            onclick: onCancel,
          },
          'Cancel',
        ),
        save,
      ),
    );
    paintErrors();
  }

  paint();

  return container;
}
