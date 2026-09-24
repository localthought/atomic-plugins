// @wc-ignore-file
/**
 * The screens before there is a calendar to show: no relay (5.1), first run
 * and connecting (5.2, 5.3), choosing the calendar (5.4) and the first
 * import (5.5).
 */
import type { CalendarEntry } from './relay.js';
import { isReadOnly } from './sync.js';
import { emptyState } from './ui/chrome.js';
import { h } from './ui/dom.js';

export function noRelay(doc: Document): HTMLElement {
  return emptyState(doc, {
    muted: true,
    title: 'Calendars can’t be reached from this server yet',
    text: 'This Atomic Server can’t reach calendar providers on your behalf, so nothing was fetched. Ask the server’s administrator to enable the integration proxy.',
  });
}

const PROVIDERS = [
  { name: 'Outlook Calendar', mark: 'O', color: '#0078d4' },
  { name: 'Apple Calendar', mark: '', color: '#8e8e93' },
];

/** 5.2 and 5.3: one primary action, and what will and won't happen. */
export function firstRun(
  doc: Document,
  {
    connecting,
    onConnect,
    onCancel,
  }: { connecting: boolean; onConnect: () => void; onCancel: () => void },
): HTMLElement {
  const google = h(
    doc,
    'li',
    {},
    h(
      doc,
      'span',
      { class: 'pl', style: 'background:#4285f4', 'aria-hidden': 'true' },
      'G',
    ),
    h(
      doc,
      'span',
      { class: 'pn' },
      'Google Calendar',
      h(doc, 'span', {}, 'Read events, send reviewed edits back'),
    ),
    connecting
      ? h(doc, 'span', {
          class: 'spin',
          style: 'color:var(--pl-accent)',
          'aria-hidden': 'true',
        })
      : h(
          doc,
          'button',
          {
            class: 'btn btn-primary btn-sm',
            'data-key': 'connect',
            'aria-label': 'Connect Google Calendar',
            onclick: onConnect,
          },
          'Connect',
        ),
  );

  return emptyState(doc, {
    title: 'Bring your calendar into Atomic',
    text: 'Events are copied into this table. Nothing is sent to Google until you review it.',
    children: [
      h(
        doc,
        'ul',
        { class: 'prov', 'aria-label': 'Calendar providers' },
        google,
        ...PROVIDERS.map(p =>
          h(
            doc,
            'li',
            { class: 'off', 'aria-disabled': 'true' },
            h(
              doc,
              'span',
              {
                class: 'pl',
                style: `background:${p.color}`,
                'aria-hidden': 'true',
              },
              p.mark,
            ),
            h(
              doc,
              'span',
              { class: 'pn' },
              p.name,
              h(doc, 'span', {}, 'Not available yet'),
            ),
          ),
        ),
      ),
      connecting
        ? h(
            doc,
            'p',
            { class: 'waiting', role: 'status' },
            'Confirm the connection in the bar above…',
            h(
              doc,
              'button',
              {
                class: 'link',
                'data-key': 'cancel-connect',
                onclick: onCancel,
              },
              'Cancel',
            ),
          )
        : h(
            doc,
            'p',
            { class: 'fine' },
            'Recurring events aren’t imported yet.',
          ),
    ],
  });
}

const ROLE: Record<string, string> = {
  owner: 'Owner',
  writer: 'Can edit',
  reader: 'View only',
  freeBusyReader: 'Free/busy only',
};

/**
 * 5.4, for one calendar per app: this table binds to the calendar chosen
 * here and never switches (README, "Choose a calendar"). Radios, not the
 * mockup's checkboxes; see the PR for that decision.
 */
export function picker(
  doc: Document,
  {
    calendars,
    onImport,
  }: { calendars: CalendarEntry[]; onImport: (id: string) => void },
): HTMLElement {
  const initial =
    calendars.find(c => c.primary)?.id ?? calendars[0]?.id ?? undefined;
  const list = h(
    doc,
    'ul',
    { class: 'pick' },
    ...calendars.map(c => {
      const readOnly = isReadOnly(c.accessRole);
      const meta = [
        c.primary ? c.id : undefined,
        ROLE[c.accessRole] ?? c.accessRole,
      ]
        .filter(Boolean)
        .join(' · ');
      const input = h(doc, 'input', {
        type: 'radio',
        name: 'calendar',
        value: c.id,
        checked: c.id === initial,
        'data-key': `pick-${c.id}`,
        'aria-describedby': readOnly ? `ro-${c.id}` : undefined,
      });

      return h(
        doc,
        'li',
        {},
        h(
          doc,
          'label',
          {},
          input,
          h(doc, 'span', {
            class: 'sw',
            style: `--c:${c.backgroundColor ?? '#4986e7'}`,
            'aria-hidden': 'true',
          }),
          h(doc, 'span', { class: 'pn' }, c.summary, h(doc, 'span', {}, meta)),
          readOnly
            ? h(doc, 'em', { class: 'tag', id: `ro-${c.id}` }, 'Read-only')
            : null,
        ),
      );
    }),
  );

  const form = h(
    doc,
    'section',
    { class: 'panel', role: 'form', 'aria-label': 'Choose a calendar' },
    h(doc, 'h2', {}, 'Which calendar should come in?'),
    h(
      doc,
      'p',
      {},
      'This app keeps one calendar. For a second calendar, add another Calendar app. Read-only calendars are imported, but their events can’t be edited here.',
    ),
    calendars.length
      ? list
      : h(
          doc,
          'p',
          { class: 'fine' },
          'Google listed no calendars for this account.',
        ),
    h(
      doc,
      'div',
      { class: 'panel-ft' },
      h(
        doc,
        'span',
        { class: 'fine' },
        'Recurring events aren’t imported yet.',
      ),
      h(
        doc,
        'button',
        {
          class: 'btn btn-primary',
          'data-key': 'import',
          disabled: !calendars.length,
          // A click, not a form submit: the frame is sandboxed without
          // allow-forms, so a submit would never be dispatched.
          onclick: () => {
            const picked = list.querySelector<HTMLInputElement>(
              'input[name="calendar"]:checked',
            );
            if (picked) onImport(picked.value);
          },
        },
        'Import this calendar',
      ),
    ),
  );

  return form;
}

/** 5.5: per-calendar progress and a skeleton, under the final chrome. */
export function importing(
  doc: Document,
  {
    calendar,
    color,
    pages,
  }: { calendar: string; color: string; pages?: number },
): HTMLElement {
  return h(
    doc,
    'div',
    { 'aria-busy': 'true' },
    h(
      doc,
      'div',
      { class: 'prog' },
      h(
        doc,
        'div',
        { class: 'prog-row' },
        h(doc, 'span', {
          class: 'sw',
          style: `--c:${color}`,
          'aria-hidden': 'true',
        }),
        h(
          doc,
          'span',
          { class: 'bar', 'aria-hidden': 'true' },
          h(doc, 'i', {}),
        ),
        h(
          doc,
          'span',
          { class: 'n' },
          h(doc, 'b', {}, calendar),
          pages
            ? ` · ${pages} ${pages === 1 ? 'page' : 'pages'} of events read`
            : ' · reading events…',
        ),
      ),
    ),
    h(
      doc,
      'div',
      { class: 'skel', 'aria-hidden': 'true' },
      h(doc, 'div', { class: 'sk h' }),
      h(doc, 'div', { class: 'sk' }),
      h(doc, 'div', { class: 'sk' }),
      h(doc, 'div', { class: 'sk h' }),
      h(doc, 'div', { class: 'sk' }),
    ),
  );
}
