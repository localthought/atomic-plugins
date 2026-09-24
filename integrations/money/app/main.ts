// @wc-ignore-file
/**
 * The drive-app entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet.
 */
import { createController, describe, type State } from './controller.js';
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

  const heading = el('h1', 'Money');
  const status = el('p');
  status.setAttribute('role', 'status');
  const importButton = el('button', 'Import statement');
  importButton.type = 'button';
  const body = el('div');
  root.replaceChildren(heading, status, importButton, body);

  const render = (state: State) => {
    status.textContent = describe(state.view);
    if (state.view.kind === 'empty')
      body.replaceChildren(el('h2', 'Bring in your bank transactions'));
    else if (state.view.kind === 'error')
      body.replaceChildren(el('p', state.view.message));
    else body.replaceChildren();
  };

  const controller = createController(store, render);
  render(controller.state());
  await controller.load();
}
