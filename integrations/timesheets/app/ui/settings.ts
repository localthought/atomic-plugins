// @wc-ignore-file
/**
 * Settings sheet (#89 frame M): account (read-only), workspace, window,
 * the zone days are grouped in (read-only), and Disconnect with an inline
 * confirmation. Disconnect is offered only when the host can forget the
 * connection (`store.proxy.disconnect`, not in the pinned host); otherwise
 * the sheet says where that is done.
 */
import type { LookbackDays } from '../../localthought.js';
import type { SetupOptions } from '../clockifyApi.js';
import { button } from './components.js';
import { sheet, type Overlay } from './detail.js';
import type { H } from './dom.js';
import { windowControl } from './states.js';

export interface SettingsProps {
  options: SetupOptions;
  choice: { workspaceId: string; lookbackDays: LookbackDays };
  timeZone: string;
  /** Where `timeZone` comes from, for the sheet's note. */
  zoneSource: 'profile' | 'browser';
  entryCount: number;
  full: boolean;
  saving: boolean;
  error?: string | undefined;
  canDisconnect: boolean;
  confirming: boolean;
  onChange: (choice: {
    workspaceId: string;
    lookbackDays: LookbackDays;
  }) => void;
  onSave: () => void;
  onCancel: () => void;
  onAskDisconnect: () => void;
  onDisconnect: () => void;
  onKeepConnected: () => void;
}

export function settingsSheet(h: H, p: SettingsProps): Overlay {
  const { user, workspaces } = p.options;
  const select = h(
    'select',
    { class: 'sel', id: 'set-ws', 'data-k': 'set-ws' },
    ...workspaces.map(w =>
      h(
        'option',
        { value: w.id, selected: w.id === p.choice.workspaceId },
        w.name,
      ),
    ),
  );
  select.addEventListener('change', () =>
    p.onChange({ ...p.choice, workspaceId: select.value }),
  );

  const disconnect = !p.canDisconnect
    ? h(
        'div',
        { class: 'field' },
        h('span', { class: 'lbl' }, 'Connection'),
        h(
          'span',
          { class: 'hint' },
          "This Atomic Server can't disconnect an app from inside the app yet. Imported entries stay either way.",
        ),
      )
    : p.confirming
      ? h(
          'div',
          {
            class: 'confirm',
            role: 'group',
            'aria-label': 'Disconnect Clockify?',
          },
          h(
            'p',
            null,
            h('strong', null, 'Disconnect Clockify?'),
            ` Syncing stops. The ${p.entryCount} ${p.entryCount === 1 ? 'entry' : 'entries'} already imported stay in this drive.`,
          ),
          h(
            'div',
            { class: 'row' },
            button(h, 'Disconnect', {
              variant: 'danger',
              key: 'disconnect-yes',
              onClick: p.onDisconnect,
            }),
            button(h, 'Cancel', {
              variant: 'ghost',
              key: 'disconnect-no',
              onClick: p.onKeepConnected,
            }),
          ),
        )
      : h(
          'div',
          null,
          button(h, 'Disconnect…', {
            variant: 'danger',
            key: 'disconnect',
            onClick: p.onAskDisconnect,
          }),
        );

  return sheet(h, {
    title: 'Settings',
    full: p.full,
    onClose: p.onCancel,
    body: [
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'lbl' }, 'Clockify account'),
        h(
          'span',
          null,
          user.name ?? user.id,
          user.email ? h('span', { class: 'muted' }, ` · ${user.email}`) : null,
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'set-ws' }, 'Workspace'),
        select,
        h(
          'span',
          { class: 'hint' },
          'Changing it imports from the new workspace on the next sync. Entries from the old one stay in the drive.',
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'lbl', id: 'set-win' }, 'Window'),
        windowControl(
          h,
          p.choice.lookbackDays,
          lookbackDays => p.onChange({ ...p.choice, lookbackDays }),
          'set-win',
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'lbl' }, 'Days are grouped in'),
        h(
          'span',
          null,
          p.timeZone,
          h(
            'span',
            { class: 'muted' },
            p.zoneSource === 'profile'
              ? ' (your Clockify profile)'
              : ' (this browser)',
          ),
        ),
      ),
      p.error ? h('p', { role: 'alert', style: 'margin: 0' }, p.error) : null,
      disconnect,
    ],
    footer: [
      button(h, p.saving ? 'Saving…' : 'Save', {
        key: 'settings-save',
        disabled: p.saving,
        onClick: p.onSave,
      }),
      button(h, 'Cancel', {
        variant: 'ghost',
        key: 'settings-cancel',
        onClick: p.onCancel,
      }),
    ],
  });
}
