// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module exports
 * `view` and renders nothing on import. One module, no stylesheet.
 *
 * On open it imports once when a connection exists, then on "Sync now".
 */
import {
  action,
  createController,
  describe,
  type ViewState,
} from './controller.js';
import type { ViewArgs } from './store.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;
  const heading = doc.createElement('h1');
  heading.textContent = 'Notion';
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const button = doc.createElement('button');
  button.type = 'button';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(heading, status, button);

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    const label = action(state);
    button.hidden = !label;
    button.textContent = label ?? '';
    button.disabled = state.kind === 'syncing';
  };

  const controller = createController(store, render);
  render(controller.state());
  button.addEventListener('click', () => {
    const { kind } = controller.state();
    void (kind === 'not-connected' ? controller.connect() : controller.sync());
  });

  try {
    const state = await controller.load();
    if (state.kind === 'ready') await controller.sync();
  } catch (error) {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  }
}
