// @wc-ignore-file
/**
 * The drive-app entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet:
 * styles are injected as one `<style>` element.
 */
import { mount } from './app.js';
import type { ViewArgs } from './store.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  await mount(root, store);
}
