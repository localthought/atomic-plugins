// @wc-ignore-file
/**
 * The Pets drive-plugin entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet.
 */
import { createController, describe, type ViewState } from './controller.js';
import type { ViewArgs } from './store.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;
  const heading = doc.createElement('h1');
  heading.textContent = 'Pets';
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const connect = doc.createElement('button');
  connect.type = 'button';
  connect.textContent = 'Connect Pets';
  const sync = doc.createElement('button');
  sync.type = 'button';
  sync.textContent = 'Sync now';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(heading, status, connect, sync);

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    connect.hidden = !(
      state.kind === 'disconnected' ||
      (state.kind === 'error' && !state.connection)
    );
    sync.hidden = !(
      state.kind === 'ready' ||
      state.kind === 'synced' ||
      state.kind === 'syncing' ||
      (state.kind === 'error' && !!state.connection)
    );
    sync.disabled = state.kind === 'syncing';
  };

  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener('click', () => void controller.connect());
  sync.addEventListener('click', () => void controller.sync());

  await controller.load().catch((error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
