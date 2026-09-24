// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet.
 *
 * Plain DOM for the states in `controller.ts`: connect, a setup form
 * (workspace and look-back), sync status and "Sync now". The full design
 * (week grid, entries, projects) is `design/` on the design branch (#89) and
 * not built here.
 */
import { LOOKBACK_OPTIONS, type LookbackDays } from '../localthought.js';
import { createController, describe, type ViewState } from './controller.js';
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
  const button = (text: string) => {
    const node = el('button', text);
    node.type = 'button';

    return node;
  };

  const heading = el('h1', 'Clockify timesheets');
  const status = el('p');
  status.setAttribute('role', 'status');
  const connect = button('Connect Clockify');
  const sync = button('Sync now');
  const settings = button('Change settings');

  // Not a <form>: the frame is sandboxed without allow-forms, so a submit
  // is blocked before any submit event fires.
  const form = el('fieldset');
  form.append(el('legend', 'Import settings'));
  const account = el('p');
  const workspaceLabel = el('label', 'Workspace ');
  const workspace = el('select');
  workspace.setAttribute('aria-label', 'Workspace');
  workspaceLabel.append(workspace);
  const lookbackLabel = el('label', 'Look-back ');
  const lookback = el('select');
  for (const days of LOOKBACK_OPTIONS) {
    const option = el('option', `the last ${days} days`);
    option.value = String(days);
    lookback.append(option);
  }
  lookback.setAttribute('aria-label', 'Look-back');
  lookbackLabel.append(lookback);
  const save = button('Save and import');
  const row = (...nodes: HTMLElement[]) => {
    const p = el('p');
    p.append(...nodes);

    return p;
  };
  form.append(account, row(workspaceLabel), row(lookbackLabel), row(save));

  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(heading, status, form, connect, sync, settings);

  const render = (state: ViewState) => {
    status.textContent = describe(state);
    connect.hidden = state.kind !== 'not-connected';
    const connected = state.kind === 'ready' || state.kind === 'syncing';
    sync.hidden = !connected;
    settings.hidden = !connected;
    sync.disabled = state.kind === 'syncing';
    settings.disabled = state.kind === 'syncing';

    form.hidden = state.kind !== 'setup' || !state.options;
    if (state.kind !== 'setup' || !state.options) return;
    const { options, draft } = state;
    account.textContent = `Clockify account: ${options.user.name ?? options.user.email ?? options.user.id}`;
    const selected =
      draft.workspaceId ??
      options.user.activeWorkspace ??
      options.workspaces[0]?.id;
    workspace.replaceChildren(
      ...options.workspaces.map(w => {
        const option = el('option', w.name);
        option.value = w.id;
        option.selected = w.id === selected;

        return option;
      }),
    );
    lookback.value = String(draft.lookbackDays ?? 30);
    save.disabled = state.busy === 'saving' || !options.workspaces.length;
  };

  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener('click', () => void controller.connect());
  sync.addEventListener('click', () => void controller.sync());
  settings.addEventListener('click', () => void controller.openSettings());
  save.addEventListener('click', () => {
    void controller.saveSettings({
      workspaceId: workspace.value,
      lookbackDays: Number(lookback.value) as LookbackDays,
    });
  });

  store.subscribe(await store.getApp(), () => void controller.appChanged());
  await controller.load().catch((error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
