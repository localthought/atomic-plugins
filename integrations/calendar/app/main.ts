// @wc-ignore-file
/**
 * The Calendar drive-plugin entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet.
 *
 * Deliberately plain: the designed chrome (integrations/calendar/design/ on
 * the design branch, #89) is separate work. This is the smallest UI that
 * makes the supported path usable: connect, choose one calendar, refresh,
 * review local edits and send them.
 */
import { createController, describe, type ViewState } from './controller.js';
import type { ViewArgs } from './store.js';
import type { Outcome } from './sync.js';

const OUTCOME: Record<Outcome['status'], string> = {
  sent: 'Sent',
  stale:
    'Changed in Google since this preview; not sent. Refresh to review it again',
  uncertain: 'Unknown whether Google applied it',
  failed: 'Google refused it',
  'not-sent': 'Not sent, because an earlier change’s outcome is unknown',
};

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;

    return node;
  };

  const button = (text: string) => {
    const node = el('button', text);
    node.type = 'button';

    return node;
  };

  const heading = el('h1', 'Calendar');
  const status = el('p');
  status.setAttribute('role', 'status');
  const connect = button('Connect Google Calendar');
  const refresh = button('Refresh');
  const choose = el('form');
  choose.setAttribute('aria-label', 'Choose a calendar');
  const conflicts = el('section');
  conflicts.setAttribute('aria-label', 'Conflicts');
  const review = el('section');
  review.setAttribute('aria-label', 'Review changes');
  const results = el('section');
  results.setAttribute('aria-label', 'Sent changes');
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(
    heading,
    status,
    connect,
    refresh,
    choose,
    conflicts,
    review,
    results,
  );

  const list = (items: string[]) => {
    const ul = el('ul');
    for (const item of items) ul.append(el('li', item));

    return ul;
  };

  const renderChoose = (state: Extract<ViewState, { kind: 'choosing' }>) => {
    const fieldset = el('fieldset');
    fieldset.append(el('legend', 'Calendar'));

    for (const calendar of state.calendars) {
      const label = el('label');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'calendar';
      radio.value = calendar.id;
      radio.checked = calendar.primary;
      const readOnly =
        calendar.accessRole === 'reader' ||
        calendar.accessRole === 'freeBusyReader';
      label.append(
        radio,
        ` ${calendar.summary}${readOnly ? ' (read-only: edits can’t be sent)' : ''}`,
      );
      fieldset.append(label, el('br'));
    }

    // A click, not a form submit: the plugin frame is sandboxed without
    // allow-forms, so a submit would never be dispatched.
    const submit = button('Import this calendar');
    submit.addEventListener('click', () => {
      const picked = choose.querySelector<HTMLInputElement>(
        'input[name="calendar"]:checked',
      );
      if (picked) void controller.choose(picked.value);
    });
    choose.replaceChildren(fieldset, submit);
  };

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    connect.hidden = !(
      state.kind === 'disconnected' ||
      (state.kind === 'error' && state.reconnect)
    );
    refresh.hidden = !(
      state.kind === 'ready' ||
      state.kind === 'refreshing' ||
      state.kind === 'sending' ||
      (state.kind === 'error' && !state.reconnect)
    );
    refresh.disabled = state.kind === 'refreshing' || state.kind === 'sending';

    if (state.kind === 'choosing') renderChoose(state);
    else choose.replaceChildren();

    const summary =
      state.kind === 'ready' || state.kind === 'sending'
        ? state.summary
        : undefined;

    conflicts.replaceChildren();
    if (summary?.conflicts.length || summary?.invalid.length)
      conflicts.append(
        el('h2', 'Left as is'),
        list([
          ...summary.conflicts.map(c => `${c.title}: ${c.fields.join(', ')}`),
          ...summary.invalid.map(
            i => `${i.title || '(untitled)'}: not sent, ${i.reason}`,
          ),
        ]),
      );

    review.replaceChildren();

    if (summary?.review.length) {
      const items = el('ul');

      for (const pending of summary.review) {
        const li = el('li');
        li.append(el('strong', pending.title));
        li.append(
          list(pending.fields.map(f => `${f.field}: ${f.before} → ${f.after}`)),
        );
        items.append(li);
      }

      const sendButton = button(
        `Send ${summary.review.length} ${summary.review.length === 1 ? 'change' : 'changes'} to Google`,
      );
      sendButton.disabled = state.kind === 'sending';
      sendButton.addEventListener('click', () => void controller.send());
      review.append(
        el('h2', 'Review changes before sending'),
        el(
          'p',
          'Only these fields are sent, and only if the event hasn’t changed in Google since this preview. Guests on these events are not emailed about these changes.',
        ),
        items,
        sendButton,
      );
    }

    const outcomes =
      state.kind === 'ready' || state.kind === 'error'
        ? (state.outcomes ?? [])
        : [];
    results.replaceChildren();
    if (outcomes.length)
      results.append(
        el('h2', 'Sent changes'),
        list(outcomes.map(o => `${o.title}: ${OUTCOME[o.status]}`)),
      );
  };

  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener('click', () => void controller.connect());
  refresh.addEventListener('click', () => void controller.refresh());

  await controller.load().catch((error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
