// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, one injected
 * `<style>` element.
 *
 * The views (#89 design: Week, Entries, Projects, detail, settings, and the
 * set-up, empty and error states) are in `ui/`, rendered from
 * `controller.ts`'s state and the timesheet it reads from the M1 observation
 * log's mirror.
 */
import { createController } from './controller.js';
import type { ViewArgs } from './store.js';
import { mountShell, type Shell } from './ui/shell.js';
import { installStyles } from './ui/theme.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  root.replaceChildren();
  installStyles(root);

  let shell: Shell | undefined;
  const controller = createController(store, () => shell?.render());
  shell = mountShell(root, controller);
  shell.render();

  store.subscribe(await store.getApp(), () => void controller.appChanged());
  await controller.load();
}
