// @wc-ignore-file
/**
 * Review changes (DESIGN.md §5.10), Conflicts (§5.11) and the keyboard
 * shortcut list (§6), as modal sheets. Nothing reaches Google except the
 * Review sheet's "Send" button; conflict choices only change rows and come
 * back here for review.
 */
import type { Projection } from '../adapter.js';
import { fieldValue, type Ctx } from './context.js';
import { bounds } from './events.js';
import type {
  Choice,
  Conflict,
  ImportSummary,
  Outcome,
  PendingEdit,
} from './sync.js';
import { LABELS } from './sync.js';
import { sheet } from './ui/chrome.js';
import { h, type Child } from './ui/dom.js';
import { hhmm, shortDay, wall } from './time.js';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const KEY_OF: Record<string, keyof Projection> = Object.fromEntries(
  Object.entries(LABELS).map(([k, v]) => [v, k as keyof Projection]),
);

function whenShort(value: Projection, zone: string): string {
  const b = bounds(value, zone);
  if (!b) return '';
  if (value.allDay) return shortDay(value.start);
  const w = wall(b.start, zone);

  return `${shortDay(w.date)} · ${hhmm(w.minutes)}`;
}

function status(doc: Document, p: 'sending' | Outcome | undefined): Child {
  if (!p) return null;
  if (p === 'sending')
    return h(
      doc,
      'span',
      { class: 'rs wait' },
      h(doc, 'span', { class: 'spin', 'aria-hidden': 'true' }),
      'Sending…',
    );

  switch (p.status) {
    case 'sent':
      return h(doc, 'span', { class: 'rs ok' }, '✓ Sent');
    case 'stale':
      return h(doc, 'span', { class: 'rs fail' }, '! Changed in Google');
    case 'uncertain':
      return h(
        doc,
        'span',
        { class: 'rs fail' },
        '! Unknown whether Google applied it',
      );
    case 'failed':
      return h(doc, 'span', { class: 'rs fail' }, '! Google refused it');
    case 'not-sent':
      return h(doc, 'span', { class: 'rs wait' }, 'Not sent');
  }
}

const OUTCOME_TEXT: Record<Outcome['status'], string> = {
  sent: 'Sent',
  stale: 'Changed in Google since this preview; not sent',
  uncertain: 'Unknown whether Google applied it',
  failed: 'Google refused it',
  'not-sent': 'Not sent, because an earlier change’s outcome is unknown',
};

export function review(
  ctx: Ctx,
  {
    summary,
    progress,
    outcomes,
    color,
    busy,
    onClose,
    onDiscard,
    onSend,
    onReviewAgain,
  }: {
    summary: ImportSummary;
    /** While sending: per edit. */
    progress?: Array<'sending' | Outcome | undefined>;
    /** After sending: what happened to each. */
    outcomes: Outcome[];
    color: string;
    busy: boolean;
    onClose: () => void;
    onDiscard: (pending: PendingEdit) => void;
    onSend: () => void;
    onReviewAgain: () => void;
  },
): HTMLElement {
  const { doc, zone } = ctx;
  const items = summary.review;
  const sending = !!progress;
  const notes: Child[] = [];

  if (summary.invalid.length)
    notes.push(
      h(
        doc,
        'p',
        { class: 'fine' },
        `Not sent: ${summary.invalid.map(i => `${i.title.trim() || '(untitled)'} (${i.reason})`).join('; ')}.`,
      ),
    );
  if (summary.localOnly)
    notes.push(
      h(
        doc,
        'p',
        { class: 'fine' },
        `${plural(summary.localOnly, 'row')} made in this table won’t be sent: creating events isn’t supported.`,
      ),
    );

  // After a send: one row per outcome.
  if (!items.length && outcomes.length) {
    const sent = outcomes.filter(o => o.status === 'sent').length;
    const stale = outcomes.filter(o => o.status === 'stale');

    return sheet(doc, {
      id: 'review',
      title: `${sent} of ${plural(outcomes.length, 'change')} sent`,
      ...(stale.length
        ? {
            subtitle: `${stale.map(o => o.title).join(', ')} ${stale.length === 1 ? 'was' : 'were'} changed in Google after you reviewed ${stale.length === 1 ? 'it' : 'them'}, so ${stale.length === 1 ? 'it was' : 'they were'} not overwritten.`,
          }
        : {}),
      onClose,
      body: [
        h(
          doc,
          'ul',
          { class: 'chg', 'aria-label': 'Sent changes' },
          ...outcomes.map(o =>
            h(
              doc,
              'li',
              {},
              h(
                doc,
                'div',
                { class: 'chg-hd' },
                h(doc, 'span', {
                  class: 'sw',
                  style: `--c:${color}`,
                  'aria-hidden': 'true',
                }),
                h(doc, 'b', {}, o.title),
                status(doc, o),
                h(
                  doc,
                  'span',
                  { class: 'sr-only' },
                  `${o.title}: ${OUTCOME_TEXT[o.status]}`,
                ),
              ),
              o.status === 'stale'
                ? h(
                    doc,
                    'div',
                    { class: 'chg-ft' },
                    h(
                      doc,
                      'button',
                      {
                        class: 'btn btn-primary btn-sm',
                        'data-key': `again-${o.title}`,
                        onclick: onReviewAgain,
                      },
                      'Review again',
                    ),
                  )
                : o.status === 'failed' || o.status === 'uncertain'
                  ? h(doc, 'p', { class: 'cf-lost' }, o.message)
                  : null,
            ),
          ),
        ),
      ],
      footer: [
        h(doc, 'p', {}, 'Only these fields were sent.'),
        h(
          doc,
          'button',
          { class: 'btn', 'data-key': 'review-done', onclick: onClose },
          'Done',
        ),
      ],
    });
  }

  if (!items.length)
    return sheet(doc, {
      id: 'review',
      title: 'Nothing to send',
      subtitle: busy
        ? 'Reading your calendar to see what changed here…'
        : 'No event here differs from Google Calendar.',
      onClose,
      body: notes,
    });

  return sheet(doc, {
    id: 'review',
    title: `Send ${plural(items.length, 'change')} to Google Calendar`,
    subtitle:
      'Only the fields shown change. Everything else on these events is left as it is in Google.',
    onClose,
    body: [
      h(
        doc,
        'ul',
        { class: 'chg', 'aria-label': 'Review changes' },
        ...items.map((pending, i) =>
          h(
            doc,
            'li',
            {},
            h(
              doc,
              'div',
              { class: 'chg-hd' },
              h(doc, 'span', {
                class: 'sw',
                style: `--c:${color}`,
                'aria-hidden': 'true',
              }),
              h(doc, 'b', {}, pending.title),
              progress?.[i]
                ? status(doc, progress[i])
                : h(
                    doc,
                    'span',
                    { class: 'when' },
                    whenShort(pending.remote, zone),
                  ),
            ),
            h(
              doc,
              'dl',
              { class: 'diff' },
              ...pending.fields.flatMap(f => {
                const key = KEY_OF[f.field];
                const before = key
                  ? fieldValue(key, pending.remote, zone)
                  : f.before;
                const after = key
                  ? fieldValue(key, pending.desired, zone)
                  : f.after;

                return [
                  h(doc, 'dt', {}, f.field),
                  h(
                    doc,
                    'dd',
                    {},
                    h(doc, 'del', {}, before),
                    h(doc, 'span', { 'aria-hidden': 'true' }, '→'),
                    h(doc, 'span', { class: 'sr-only' }, ' becomes '),
                    h(doc, 'ins', {}, after),
                  ),
                ];
              }),
            ),
            sending
              ? null
              : h(
                  doc,
                  'div',
                  { class: 'chg-ft' },
                  h(
                    doc,
                    'button',
                    {
                      class: 'btn btn-sm',
                      'data-key': `discard-${i}`,
                      'aria-label': `Discard the change to ${pending.title}`,
                      onclick: () => onDiscard(pending),
                    },
                    'Discard',
                  ),
                ),
          ),
        ),
      ),
      ...notes,
    ],
    footer: [
      h(
        doc,
        'p',
        {},
        'Guests on these events are not emailed about these changes.',
      ),
      h(
        doc,
        'button',
        {
          class: 'btn btn-primary',
          'data-key': 'send',
          disabled: sending || busy,
          'aria-label': `Send ${plural(items.length, 'change')} to Google`,
          onclick: onSend,
        },
        sending ? 'Sending…' : `Send ${plural(items.length, 'change')}`,
      ),
    ],
  });
}

export function conflicts(
  ctx: Ctx,
  {
    list,
    color,
    choices,
    confirming,
    errors,
    onClose,
    onChoose,
    onResolve,
    onKeep,
    onRemove,
    onConfirm,
  }: {
    list: Conflict[];
    color: string;
    choices: Map<Conflict, Partial<Record<keyof Projection, Choice>>>;
    confirming?: Conflict;
    errors: Map<Conflict, string>;
    onClose: () => void;
    onChoose: (c: Conflict, field: keyof Projection, choice: Choice) => void;
    onResolve: (c: Conflict) => void;
    onKeep: (c: Conflict) => void;
    onRemove: (c: Conflict) => void;
    onConfirm: (c: Conflict | undefined) => void;
  },
): HTMLElement {
  const { doc, zone } = ctx;

  const card = (c: Conflict, index: number) => {
    const date = c.local ?? c.remote;
    const head = h(
      doc,
      'div',
      { class: 'chg-hd' },
      h(doc, 'span', {
        class: 'sw',
        style: `--c:${color}`,
        'aria-hidden': 'true',
      }),
      h(doc, 'b', {}, c.title),
      date
        ? h(
            doc,
            'span',
            { class: 'when' },
            whenShort(date, zone).split(' · ')[0],
          )
        : null,
    );

    if (c.kind === 'both' && c.local && c.remote) {
      const picked = choices.get(c) ?? {};
      const fields = c.fields as Array<keyof Projection>;
      const ready = fields.every(f => picked[f]);

      return h(
        doc,
        'li',
        {},
        head,
        h(
          doc,
          'div',
          { class: 'cf' },
          ...fields.map(field => {
            const name = `cf-${index}-${field}`;
            const option = (choice: Choice, label: string, value: Projection) =>
              h(
                doc,
                'label',
                { class: 'opt' },
                h(doc, 'input', {
                  type: 'radio',
                  name,
                  checked: picked[field] === choice,
                  'data-key': `${name}-${choice}`,
                  onchange: () => onChoose(c, field, choice),
                }),
                h(doc, 'small', {}, label),
                fieldValue(field, value, zone),
              );

            return h(
              doc,
              'div',
              {
                class: 'cf-row',
                role: 'radiogroup',
                'aria-label': LABELS[field] ?? field,
              },
              h(doc, 'span', {}, LABELS[field] ?? field),
              option('mine', 'Keep mine', c.local!),
              option('google', 'Use Google’s', c.remote!),
            );
          }),
        ),
        errors.get(c)
          ? h(doc, 'p', { class: 'err', role: 'alert' }, errors.get(c)!)
          : null,
        h(
          doc,
          'div',
          { class: 'chg-ft' },
          h(
            doc,
            'button',
            {
              class: 'btn btn-primary btn-sm',
              disabled: !ready,
              'data-key': `resolve-${index}`,
              onclick: () => onResolve(c),
            },
            'Resolve',
          ),
        ),
      );
    }

    if (c.kind === 'missing-remote')
      return h(
        doc,
        'li',
        {},
        head,
        h(
          doc,
          'p',
          { class: 'cf-lost' },
          'This event is no longer in Google Calendar — it was cancelled, became recurring, or you lost access. Your copy here was not deleted.',
        ),
        confirming === c
          ? h(
              doc,
              'div',
              {
                class: 'chg-ft confirm',
                role: 'group',
                'aria-label': 'Confirm removal',
              },
              h(
                doc,
                'span',
                {},
                'Remove the copy in this table? This can’t be undone.',
              ),
              h(
                doc,
                'button',
                {
                  class: 'btn btn-sm',
                  'data-key': `cancel-remove-${index}`,
                  onclick: () => onConfirm(undefined),
                },
                'Cancel',
              ),
              h(
                doc,
                'button',
                {
                  class: 'btn btn-sm btn-neg',
                  'data-key': `confirm-remove-${index}`,
                  onclick: () => onRemove(c),
                },
                'Remove',
              ),
            )
          : h(
              doc,
              'div',
              { class: 'chg-ft' },
              h(
                doc,
                'button',
                {
                  class: 'btn btn-sm',
                  'data-key': `remove-${index}`,
                  onclick: () => onConfirm(c),
                },
                'Remove local copy',
              ),
              h(
                doc,
                'button',
                {
                  class: 'btn btn-sm',
                  'data-key': `keep-${index}`,
                  onclick: () => onKeep(c),
                },
                'Keep as local event',
              ),
            ),
      );

    return h(
      doc,
      'li',
      {},
      head,
      h(
        doc,
        'p',
        { class: 'cf-lost' },
        `The row this Google event was imported into is missing or bound to another event${c.id ? ` (Google event id ${c.id})` : ''}. Nothing was changed automatically; fix the row in the table, then sync again.`,
      ),
    );
  };

  return sheet(doc, {
    id: 'conflicts',
    title: list.length
      ? `${plural(list.length, 'event')} ${list.length === 1 ? 'needs' : 'need'} a decision`
      : 'No conflicts',
    subtitle: list.length
      ? 'These changed both here and in Google since the last sync, or are gone from Google. Nothing is overwritten until you choose.'
      : 'Everything here agrees with Google, or is waiting for review.',
    onClose,
    body: [
      h(
        doc,
        'ul',
        { class: 'chg', 'aria-label': 'Conflicts' },
        ...list.map(card),
      ),
    ],
  });
}

export const SHORTCUTS: Array<[string[], string]> = [
  [['t'], 'Today'],
  [['←', '→'], 'Previous or next period'],
  [['k', 'j'], 'Previous or next period'],
  [['a'], 'Agenda'],
  [['w'], 'Week'],
  [['Enter'], 'Open the focused event'],
  [['e'], 'Edit the open or focused event'],
  [['Esc'], 'Close the drawer, sheet or menu'],
  [['?'], 'This list'],
];

export function shortcuts(ctx: Ctx, onClose: () => void): HTMLElement {
  const { doc } = ctx;

  return sheet(doc, {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    subtitle:
      'They work when focus is in the calendar and not in a text field.',
    onClose,
    body: [
      h(
        doc,
        'dl',
        { class: 'kbd' },
        ...SHORTCUTS.flatMap(([keys, what]) => [
          h(
            doc,
            'dt',
            {},
            ...keys.flatMap((k, i) => [i ? ' ' : null, h(doc, 'kbd', {}, k)]),
          ),
          h(doc, 'dd', {}, what),
        ]),
      ),
    ],
  });
}
