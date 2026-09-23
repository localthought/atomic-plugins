// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet.
 */
import { createController, describe, type ViewState } from './controller.js';
import type { ViewArgs } from './store.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;
  const heading = doc.createElement('h1');
  heading.textContent = 'Clockify timesheets';
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Sync now';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(heading, status, button);

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    button.hidden = state.kind !== 'ready' && state.kind !== 'syncing';
    button.disabled = state.kind !== 'ready';
  };

  const controller = createController(store, render);
  render(controller.state());
  button.addEventListener('click', () => void controller.sync());

  const fail = (error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  };

  const app = await store.getApp();
  // Only re-read config while idle: rows are written under the data table,
  // but when there is none they land under the app itself and would notify
  // this subscription on every write.
  store.subscribe(app, () => {
    const kind = controller.state().kind;
    if (kind !== 'syncing') void controller.load().catch(fail);
  });
  await controller.load().catch(fail);
}
