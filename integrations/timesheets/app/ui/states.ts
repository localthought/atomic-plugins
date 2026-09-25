// @wc-ignore-file
/**
 * Set-up, empty and error states (#89 frames F, G, H, I, J, K, L): the
 * first-run card, waiting on the host's consent bar, the workspace and
 * window form, the first-import skeleton, the empty window, the error
 * banners over data already on screen, the no-relay notice and the band
 * over a week outside the import window.
 */
import type { LookbackDays } from '../../localthought.js';
import type { SetupOptions } from '../clockifyApi.js';
import type { Settings } from '../config.js';
import { formatDay, type DayKey } from '../model/time.js';
import type { Problem } from '../problem.js';
import { banner, button, emptyState, extLink, panel } from './components.js';
import { icon, type H } from './dom.js';
import { CLOCKIFY_TRACKER } from './detail.js';

export function firstRun(h: H, onConnect: () => void) {
  const item = (ok: boolean, text: string) =>
    h(
      'li',
      null,
      icon(h.doc, ok ? 'check' : 'minus', ok ? 'y' : 'n'),
      h('span', null, text),
    );

  return panel(
    h,
    'Bring your Clockify time into this drive',
    h(
      'p',
      null,
      'Copies your completed time entries from the last 7 or 30 days, so you can see them by week and link them from your own pages.',
    ),
    h(
      'ul',
      null,
      item(
        true,
        'Description, project, client, start, end and billable status',
      ),
      item(
        true,
        'A Clockify API key, entered on the next page. This app never sees it.',
      ),
      item(
        false,
        'Nothing is written to Clockify. Running timers, tags and rates are not copied.',
      ),
    ),
    h(
      'div',
      null,
      button(h, 'Connect Clockify', { key: 'connect', onClick: onConnect }),
    ),
    h(
      'p',
      { class: 'fine' },
      'Your API key is under Preferences → Manage API keys in Clockify.',
    ),
  );
}

export const waiting = (h: H) =>
  panel(
    h,
    'Finish connecting in the bar above this app',
    h(
      'p',
      { class: 'muted' },
      'Your Atomic Server opened a Clockify connection prompt at the top of the page. Paste your API key there and choose Connect.',
    ),
    h('div', null, button(h, 'Waiting…', { disabled: true })),
  );

export const loadingPanel = (h: H, text: string) =>
  panel(h, text, h('div', { class: 'skel', style: 'width: 60%' }));

export function setupError(h: H, error: string, onRetry: () => void) {
  return panel(
    h,
    'Could not read your Clockify workspaces',
    h('p', { class: 'muted' }, error),
    h(
      'div',
      null,
      button(h, 'Try again', { key: 'setup-retry', onClick: onRetry }),
    ),
  );
}

/** The 7 / 30 day segmented control (`aria-pressed` buttons in a group). */
export function windowControl(
  h: H,
  value: LookbackDays,
  onChange: (days: LookbackDays) => void,
  labelId: string,
) {
  const choice = (days: LookbackDays) => {
    const b = h(
      'button',
      {
        type: 'button',
        'aria-pressed': value === days ? 'true' : 'false',
        'data-k': `window:${days}`,
      },
      `Last ${days} days`,
    );
    b.addEventListener('click', () => onChange(days));

    return b;
  };

  return h(
    'div',
    { class: 'seg', role: 'group', 'aria-labelledby': labelId },
    choice(7),
    choice(30),
  );
}

export interface SetupFormProps {
  options: SetupOptions;
  draft: Partial<Settings>;
  saving: boolean;
  error?: string | undefined;
  /** Form state kept by the view between renders. */
  choice: { workspaceId: string; lookbackDays: LookbackDays };
  /** `25 Aug – 24 Sep`, for the chosen window as of now. */
  windowText: (days: LookbackDays) => string;
  onChange: (choice: {
    workspaceId: string;
    lookbackDays: LookbackDays;
  }) => void;
  onSubmit: () => void;
}

/** G2: workspace (only when there is more than one) and window. Not a
 * `<form>`: the frame is sandboxed without allow-forms. */
export function setupForm(h: H, p: SetupFormProps) {
  const { choice } = p;
  const many = p.options.workspaces.length > 1;
  const workspaces = many
    ? h(
        'fieldset',
        { class: 'field' },
        h('legend', { class: 'lbl' }, 'Workspace'),
        h(
          'div',
          { class: 'opts' },
          ...p.options.workspaces.map(w => {
            const input = h('input', {
              type: 'radio',
              name: 'workspace',
              value: w.id,
              checked: w.id === choice.workspaceId,
              'data-k': `ws:${w.id}`,
            });
            input.addEventListener('change', () =>
              p.onChange({ ...choice, workspaceId: w.id }),
            );

            return h('label', { class: 'opt' }, input, h('span', null, w.name));
          }),
        ),
      )
    : null;

  return panel(
    h,
    'What should be imported?',
    workspaces,
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lbl', id: 'win-l' }, 'Window'),
      windowControl(
        h,
        choice.lookbackDays,
        lookbackDays => p.onChange({ ...choice, lookbackDays }),
        'win-l',
      ),
      h(
        'span',
        { class: 'hint' },
        `Recomputed on every sync: ${p.windowText(choice.lookbackDays)} today.`,
      ),
    ),
    p.error ? h('p', { role: 'alert' }, p.error) : null,
    h(
      'div',
      null,
      button(h, p.saving ? 'Importing…' : 'Import entries', {
        key: 'import',
        disabled: p.saving || !choice.workspaceId,
        onClick: p.onSubmit,
      }),
    ),
  );
}

/** H: the Week view's shape while the first import runs. */
export function skeleton(h: H) {
  const row = (fade: boolean) =>
    h(
      'div',
      { class: 'skelgrid' },
      h('div', { class: 'skel', style: 'width: 60%' }),
      ...Array.from({ length: 8 }, () =>
        h('div', { class: 'skel', style: fade ? 'opacity: 0.4' : undefined }),
      ),
    );

  return [
    h(
      'div',
      {
        class: 'card',
        style: 'padding: 14px; display: grid; gap: 16px',
        'aria-hidden': 'true',
      },
      row(false),
      row(false),
      row(true),
      row(true),
    ),
    h(
      'p',
      { class: 'muted', style: 'margin: 0; font-size: 12.5px' },
      'The first import can take a minute: every entry is one save in your drive.',
    ),
  ];
}

/** I: connected and synced, nothing in the window. */
export function emptyWindow(
  h: H,
  p: {
    from: DayKey;
    to: DayKey;
    lookbackDays: LookbackDays;
    syncing: boolean;
    onSync: () => void;
    onWiden: () => void;
    openExternal?: ((url: string) => void) | undefined;
  },
) {
  const range =
    p.from.slice(0, 7) === p.to.slice(0, 7)
      ? `${Number(p.from.slice(8))} and ${formatDay(p.to)}`
      : `${formatDay(p.from)} and ${formatDay(p.to)}`;

  return emptyState(h, {
    lead: `No completed time entries between ${range}.`,
    text: 'Entries appear here once they are stopped in Clockify. A running timer is not imported.',
    actions: [
      button(h, 'Sync now', {
        key: 'empty-sync',
        disabled: p.syncing,
        onClick: p.onSync,
      }),
      p.lookbackDays === 7
        ? button(h, 'Import 30 days instead', {
            variant: 'sec',
            key: 'widen',
            disabled: p.syncing,
            onClick: p.onWiden,
          })
        : null,
    ],
    link: extLink(h, CLOCKIFY_TRACKER, 'Open Clockify', 'link', p.openExternal),
  });
}

export interface ProblemActions {
  reconnect: () => void;
  chooseWorkspace: () => void;
  retry: () => void;
  narrow: () => void;
}

/** J: one banner per problem kind, over the data already on screen. */
export function problemBanner(
  h: H,
  problem: Problem,
  p: {
    workspaceName?: string | undefined;
    lookbackDays: LookbackDays;
    /** Seconds left before a rate-limited retry is allowed. */
    waitSeconds: number;
    syncing: boolean;
    actions: ProblemActions;
  },
) {
  const details = { summary: 'Details', text: problem.detail };
  const retry = (variant: 'sec' | 'primary' = 'sec') =>
    button(
      h,
      p.waitSeconds > 0 ? `Try again (${p.waitSeconds} s)` : 'Try again',
      {
        variant,
        key: 'retry',
        disabled: p.waitSeconds > 0 || p.syncing,
        onClick: p.actions.retry,
      },
    );

  switch (problem.kind) {
    case 'reauth':
      return banner(h, {
        tone: 'warn',
        icon: 'warn',
        role: 'alert',
        lead: 'Clockify no longer accepts this connection.',
        text: 'The API key may have been deleted or regenerated.',
        action: button(h, 'Reconnect Clockify', {
          key: 'reconnect',
          onClick: p.actions.reconnect,
        }),
        details,
      });
    case 'forbidden':
      return banner(h, {
        tone: 'neg',
        icon: 'err',
        role: 'alert',
        lead: `This Clockify account cannot read time entries in ${
          p.workspaceName ?? 'this workspace'
        }.`,
        action: button(h, 'Choose another workspace', {
          variant: 'sec',
          key: 'choose-ws',
          onClick: p.actions.chooseWorkspace,
        }),
        details,
      });
    case 'rate-limited':
      return banner(h, {
        tone: 'warn',
        icon: 'warn',
        role: 'alert',
        lead: 'Clockify asked for fewer requests.',
        text:
          p.waitSeconds > 0
            ? `Try again in ${p.waitSeconds} seconds.`
            : 'You can try again now.',
        action: retry(),
        details,
      });
    case 'network':
      return banner(h, {
        tone: 'neg',
        icon: 'err',
        role: 'alert',
        lead: 'Could not reach the integration proxy.',
        text: 'Your imported entries are still here.',
        action: retry(),
        details,
      });
    case 'too-many':
      return banner(h, {
        tone: 'neg',
        icon: 'err',
        role: 'alert',
        lead: 'Clockify returned more than 10,000 entries for this window,',
        text: 'the most this app imports at once.',
        action:
          p.lookbackDays === 30
            ? button(h, 'Import 7 days instead', {
                variant: 'sec',
                key: 'narrow',
                onClick: p.actions.narrow,
              })
            : retry(),
        details,
      });
    default:
      return banner(h, {
        tone: 'neg',
        icon: 'err',
        role: 'alert',
        lead: 'The last sync failed.',
        text: 'Your imported entries are still here.',
        action: retry(),
        details,
      });
  }
}

/** Non-fatal sync warnings (e.g. project names unavailable), dismissable. */
export function warningBanner(h: H, warnings: string[], onDismiss: () => void) {
  const names = warnings.some(w => /projects/.test(w));

  return banner(h, {
    tone: 'warn',
    icon: 'warn',
    lead: names
      ? 'Project names could not be loaded,'
      : 'The last sync finished with warnings.',
    ...(names ? { text: 'so some entries show a project id.' } : {}),
    action: button(h, 'Dismiss', {
      variant: 'ghost',
      icon: 'x',
      iconOnly: true,
      key: 'dismiss',
      onClick: onDismiss,
    }),
    details: { summary: 'Details', text: warnings.join('\n') },
  });
}

/** K: the host offers no proxy relay. */
export const noRelay = (h: H) =>
  banner(h, {
    tone: 'info',
    icon: 'plug',
    lead: "This Atomic Server can't connect apps to Clockify yet.",
    text: 'Entries imported earlier are still shown.',
    details: {
      summary: 'Details for your admin',
      text: 'The host does not provide store.proxy (the integration-proxy relay for plugin frames).',
    },
  });

/** L: the week starts before the import window. */
export function outsideWindow(
  h: H,
  p: {
    windowStart: DayKey;
    lookbackDays: LookbackDays;
    syncing: boolean;
    onWiden: () => void;
  },
) {
  return h(
    'div',
    { class: 'banner info' },
    icon(h.doc, 'info'),
    h(
      'p',
      null,
      'Before ',
      h('strong', null, formatDay(p.windowStart)),
      ` is outside your ${p.lookbackDays}-day import window. Only entries imported earlier are listed.`,
    ),
    p.lookbackDays === 7
      ? button(h, 'Import 30 days', {
          variant: 'sec',
          key: 'widen-band',
          disabled: p.syncing,
          onClick: p.onWiden,
        })
      : h('span'),
  );
}
