// @wc-ignore-file
/**
 * The Moneybird drive-app entry point (read-only contacts, atomic-plugins#102).
 * The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`,
 * so this module exports `view` and does not render on import. One module,
 * no stylesheet, no network access of its own: every call goes through the
 * host's proxy relay.
 */
import { createController, describe, type ViewState } from './controller.js';
import type { ViewArgs } from './store.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;

    return node;
  };

  const heading = el('h1', 'Moneybird');
  const status = el('p');
  status.setAttribute('role', 'status');
  const connect = el('button', 'Connect Moneybird');
  const label = el('label', 'Administration ');
  const select = el('select');
  label.append(select);
  const importButton = el('button', 'Import contacts');
  const sync = el('button', 'Sync now');
  const change = el('button', 'Change administration');
  for (const button of [connect, importButton, sync, change])
    button.type = 'button';
  const chooser = el('div');
  chooser.append(label, importButton);
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(heading, status, connect, chooser, sync, change);

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    connect.hidden = !(
      state.kind === 'disconnected' ||
      (state.kind === 'error' && !state.connection)
    );
    chooser.hidden = state.kind !== 'choosing';

    if (state.kind === 'choosing') {
      select.replaceChildren(
        ...state.administrations.map(a => {
          const option = el('option', a.name);
          option.value = a.id;

          return option;
        }),
      );
      importButton.disabled = state.administrations.length === 0;
    }

    const known =
      state.kind === 'synced' ||
      state.kind === 'syncing' ||
      (state.kind === 'error' && !!state.administration);
    sync.hidden = !known;
    sync.disabled = state.kind === 'syncing';
    change.hidden = !known;
    change.disabled = state.kind === 'syncing';
  };

  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener('click', () => void controller.connect());
  importButton.addEventListener(
    'click',
    () => void controller.select(select.value),
  );
  sync.addEventListener('click', () => void controller.sync());
  change.addEventListener('click', () => void controller.change());

  await controller.load().catch((error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
