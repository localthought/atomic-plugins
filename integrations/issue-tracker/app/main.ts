// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module exports
 * `view` and renders nothing on import. One module, no stylesheet.
 *
 * Plain DOM, deliberately minimal: the designed board/list/detail views are
 * pending the issue-tracker design (#89, PR #103). This view is the
 * connection flow, the sync status, the review list for GitHub writes, the
 * conflict choice and a plain list of the table's issues.
 *
 * Sync runs when the view opens (once a repository is bound) and on
 * "Sync now". Nothing runs while the app is closed.
 */
import {
  action,
  createController,
  describe,
  describeHeld,
  type ViewState,
} from './controller.js';
import type { ViewArgs } from './store.js';

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

  const button = (label: string) => {
    const b = el('button', label);
    b.type = 'button';

    return b;
  };

  const heading = el('h1', 'GitHub issues');
  const status = el('p');
  status.setAttribute('role', 'status');

  // Not a <form>: the frame's sandbox has no allow-forms, and a sandboxed
  // form never even fires `submit`.
  const form = el('div');
  const label = el('label', 'Repository (owner/name) ');
  const input = el('input');
  input.name = 'repository';
  input.autocomplete = 'off';
  input.placeholder = 'octocat/hello-world';
  label.append(input);
  const effects = el(
    'p',
    'This app imports the repository’s issues and comments into this table. ' +
      'Changes you make here are sent to GitHub only after you review them: ' +
      'moving an issue to Done closes it, moving it back reopens it, and Doing ' +
      'adds the atomic:doing label. One app syncs one repository.',
  );
  const use = button('Use this repository');
  form.append(label, effects, use);

  const review = el('section');
  review.setAttribute('aria-label', 'Changes to send to GitHub');
  const reviewHeading = el('h2', 'Waiting for your review');
  const reviewList = el('ul');
  const send = button('Send to GitHub');
  review.append(reviewHeading, reviewList, send);

  const conflict = el('section');
  conflict.setAttribute('aria-label', 'Conflict');
  const keepRemote = button('Keep GitHub’s version');
  const keepLocal = button('Keep this table’s version');
  conflict.append(keepRemote, keepLocal);

  const primary = button('');
  const issuesHeading = el('h2', 'Issues');
  const issues = el('ul');
  issues.setAttribute('aria-label', 'Issues');

  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(
    heading,
    status,
    form,
    primary,
    review,
    conflict,
    issuesHeading,
    issues,
  );

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    const primaryLabel = action(state);
    primary.hidden = !primaryLabel;
    primary.textContent = primaryLabel ?? '';
    const busy = state.kind === 'ready' && !!state.busy;
    primary.disabled = busy;
    form.hidden = state.kind !== 'choose-repository';
    use.disabled = input.disabled =
      state.kind === 'choose-repository' && !!state.settingUp;

    const ready = state.kind === 'ready' ? state : undefined;
    const held = !ready?.problem ? (ready?.last?.result.held ?? []) : [];
    review.hidden = held.length === 0;
    send.disabled = busy;
    send.textContent = `Send ${held.length} ${held.length === 1 ? 'change' : 'changes'} to GitHub`;
    reviewList.replaceChildren(...held.map(h => el('li', describeHeld(h))));

    conflict.hidden = ready?.problem?.kind !== 'conflict';
    keepLocal.disabled = keepRemote.disabled = busy;

    const rows = ready?.last?.result.rows ?? [];
    issuesHeading.hidden = rows.length === 0;
    issues.replaceChildren(
      ...rows.map(row => {
        const item = el(
          'li',
          `${row.number ? `#${row.number}` : 'New'} ${row.title} · ${row.status}`,
        );
        item.dataset.subject = row.subject;

        return item;
      }),
    );
  };

  const controller = createController(store, render);
  render(controller.state());

  primary.addEventListener('click', () => {
    const state = controller.state();
    void (state.kind === 'not-connected' ||
    (state.kind === 'ready' && state.problem?.kind === 'reconnect')
      ? controller.connect()
      : controller.sync());
  });
  use.addEventListener('click', () => void controller.choose(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') void controller.choose(input.value);
  });
  send.addEventListener('click', () => void controller.send());
  keepRemote.addEventListener('click', () => void controller.keep('remote'));
  keepLocal.addEventListener('click', () => void controller.keep('local'));

  try {
    const state = await controller.load();
    if (state.kind === 'ready') await controller.sync();
  } catch (error) {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  }
}
