// @wc-ignore-file
/**
 * The issue tracker's screens as plain-DOM builders over `ViewState` plus
 * the view's own UI state (`Ui`). They render from data and call back into
 * `Actions`; they keep no state themselves. `main.ts` owns both.
 */
import {
  describe,
  describeHeld,
  type Ready,
  type RepositoryListing,
  type ViewState,
} from './controller.js';
import { markdown } from './markdown.js';
import {
  ago,
  bannerFor,
  canMove,
  columns,
  connectionLine,
  countText,
  filtering,
  labelNames,
  MARKER_TEXT,
  markers,
  matches,
  pendingComments,
  pillFor,
  SHORTCUTS,
  short,
  STATUSES,
  type BannerAction,
  type DetailMode,
  type Filter,
  type Layout,
  type Marker,
} from './model.js';
import type { ConflictField, IssueRow, Side, Status } from './sync.js';
import type { Repository } from './transport.js';
import { h, icon, type Child } from './ui/dom.js';
import {
  banner,
  button,
  chip,
  connectionBar,
  empty,
  header,
  iconButton,
  pill,
  searchField,
  segmented,
  sourceChip,
  statusGlyph,
  type Glyph,
} from './ui/kit.js';
import type { Size } from './ui/theme.js';

export type Panel =
  | { kind: 'issue'; subject: string }
  | { kind: 'new' }
  | { kind: 'review' }
  | {
      kind: 'conflict';
      fields?: ConflictField[];
      error?: string;
      choices: Record<string, Side>;
    };

export interface Drafts {
  /** Title being edited, for the open issue (undefined: not edited). */
  title?: string;
  /** Description being edited in the Write tab. */
  body?: string;
  tab: 'write' | 'preview';
  comment: string;
  newTitle: string;
  newBody: string;
  newStatus: Status;
}

export interface Ui {
  size: Size;
  layout?: Layout;
  search: string;
  label?: string;
  panel?: Panel;
  /** Subject whose card or row has keyboard focus. */
  focus?: string;
  allDone: boolean;
  /** List groups the person collapsed or expanded (Done starts collapsed). */
  groups: Partial<Record<Status, boolean>>;
  menu?: string;
  help: boolean;
  drafts: Drafts;
  repoFilter: string;
  repoChoice?: string;
  typedRepo: string;
  /** A banner raised by a sync in this view (`role="alert"`). */
  alert: boolean;
  /** The host can take this app off its connection (`proxy.disconnect`). */
  canDisconnect?: boolean;
  /** Rows to highlight after new data arrived. */
  flash: Set<string>;
  /** Seconds until the automatic retry after a transient failure. */
  retryIn?: number;
  now: number;
}

export interface Actions {
  connect(): void;
  listRepositories(): void;
  choose(repository: string): void;
  sync(): void;
  send(): void;
  move(subject: string, status: Status, via: 'drag' | 'menu' | 'key'): void;
  open(panel: Panel | undefined, focusBack?: string): void;
  saveTitle(subject: string, title: string): void;
  saveBody(subject: string, body: string): void;
  comment(subject: string, body: string): void;
  create(): void;
  resolve(): void;
  setUi(patch: Partial<Ui>, render?: boolean): void;
  setDrafts(patch: Partial<Drafts>, render?: boolean): void;
  openGitHub(url: string): void;
  focusSearch(): void;
  disconnect(): void;
}

const GLYPH: Record<Status, Glyph> = {
  Todo: 'todo',
  Doing: 'doing',
  Done: 'done',
};

export const refOf = (row: IssueRow) =>
  row.number !== undefined ? `#${row.number}` : 'New';

const repoUrl = (repository: string) => `https://github.com/${repository}`;

// ---------------------------------------------------------------- chrome

function appHeader(state: ViewState, ui: Ui, actions: Actions): HTMLElement {
  const name = [h('span', { class: 'sr' }, 'GitHub '), 'Issues'];
  const repository =
    state.kind === 'ready'
      ? state.repository
      : state.kind === 'choose-repository'
        ? 'choose a repository'
        : undefined;
  const small = ui.size === 's';
  const p = pillFor(state, ui.now);
  let pillNode: HTMLElement | null = null;

  if (p) {
    const failed = p.state === 'error';
    const text =
      failed && ui.retryIn !== undefined
        ? `Sync failed · retrying in ${Math.max(1, Math.round(ui.retryIn / 60))} min`
        : small && p.state === 'synced' && p.text.startsWith('Synced ')
          ? p.text.slice('Synced '.length)
          : p.text;
    pillNode = failed
      ? h(
          'span',
          { class: 'pill-wrap' },
          pill('error', text, () =>
            actions.setUi({ menu: ui.menu === 'pill' ? undefined : 'pill' }),
          ),
          ui.menu === 'pill' && state.kind === 'ready'
            ? failurePopover(state, ui, actions)
            : null,
        )
      : pill(p.state, text);
  }

  const newIssue =
    state.kind === 'ready'
      ? small
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn primary icon-only',
              'aria-label': 'New issue',
              title: 'New issue (N)',
              'data-key': 'new-issue',
              onclick: () => actions.open({ kind: 'new' }, 'new-issue'),
            },
            icon('plus', 14),
          )
        : button(
            'New issue',
            () => actions.open({ kind: 'new' }, 'new-issue'),
            {
              kind: 'primary',
              iconName: 'plus',
              'data-key': 'new-issue',
            },
          )
      : null;

  return header(
    name,
    repository && !small ? sourceChip('GitHub', repository) : null,
    h('span', { class: 'spacer' }),
    pillNode,
    newIssue,
  );
}

function failurePopover(state: Ready, ui: Ui, actions: Actions): HTMLElement {
  const message =
    state.problem?.kind === 'failed' ? state.problem.message : 'Unknown error';

  return h(
    'div',
    { class: 'popover', role: 'dialog', 'aria-label': 'Sync failed' },
    h('p', null, h('b', null, 'GitHub or the host did not answer. '), message),
    h(
      'p',
      { class: 'muted' },
      ui.retryIn !== undefined
        ? 'Retrying automatically while this app is open: 4 min, then 8, up to once an hour.'
        : 'Sync runs when this app opens and on Sync now.',
    ),
    button(
      'Retry now',
      () => {
        actions.setUi({ menu: undefined }, false);
        actions.sync();
      },
      { kind: 'primary', sm: true },
    ),
  );
}

function connBar(state: Ready, ui: Ui, actions: Actions): HTMLElement {
  const held = state.problem ? 0 : (state.last?.result.held.length ?? 0);
  const busy = !!state.busy;
  const menuOpen = ui.menu === 'conn';
  const progress =
    state.busy === 'syncing' || state.busy === 'sending' ? true : undefined;

  const bar = connectionBar(
    [
      ui.size === 's'
        ? h('span', { class: 'mono acct' }, state.repository)
        : h('span', { class: 'acct' }, 'GitHub'),
      // A phone-width bar keeps to the repository and its actions; the
      // pill already says when it last synced.
      ui.size === 's' && !held ? null : h('span', null, connectionLine(state)),
    ],
    [
      held && !state.last?.result.held.some(x => x.unconfirmed)
        ? h(
            'button',
            {
              type: 'button',
              class: 'link-btn',
              'data-key': 'review',
              disabled: busy,
              onclick: () => actions.open({ kind: 'review' }, 'review'),
            },
            'Review and send',
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'link-btn',
          'data-key': 'sync-now',
          disabled: busy,
          onclick: () => actions.sync(),
        },
        'Sync now',
      ),
      h(
        'span',
        { class: 'conn-menu' },
        iconButton(
          'more',
          'Connection menu',
          () => actions.setUi({ menu: menuOpen ? undefined : 'conn' }),
          {
            sm: true,
            'aria-haspopup': 'menu',
            'aria-expanded': String(menuOpen),
          },
        ),
        menuOpen
          ? menu(
              'Connection',
              [
                {
                  label: 'Open repository on GitHub',
                  run: () => actions.openGitHub(repoUrl(state.repository)),
                },
                {
                  label: 'Reconnect GitHub',
                  run: () => actions.connect(),
                  disabled: state.problem?.kind !== 'reconnect',
                },
                {
                  label: 'Disconnect GitHub',
                  run: () => actions.disconnect(),
                  disabled: !ui.canDisconnect,
                },
                {
                  label: 'Change repository: install another app',
                  run: () => {},
                  disabled: true,
                },
                {
                  label: 'Keyboard shortcuts',
                  run: () => actions.setUi({ help: true, menu: undefined }),
                },
              ],
              actions,
            )
          : null,
      ),
    ],
    progress,
  );
  // The last pass in full ("2 issues and 1 comment in sync …; 0 added …"),
  // as the bar's tooltip.
  bar.title = describe(state);

  return bar;
}

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
  glyph?: Glyph;
}

function menu(label: string, items: MenuItem[], actions: Actions): HTMLElement {
  const node = h(
    'div',
    { class: 'menu', role: 'menu', 'aria-label': label },
    items.map(item =>
      h(
        'button',
        {
          type: 'button',
          role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
          ...(item.checked === undefined
            ? {}
            : { 'aria-checked': String(item.checked) }),
          disabled: !!item.disabled,
          onclick: () => {
            actions.setUi({ menu: undefined }, false);
            item.run();
          },
        },
        item.glyph ? statusGlyph(item.glyph) : null,
        item.label,
      ),
    ),
  );
  node.addEventListener('keydown', event => {
    const e = event as KeyboardEvent;
    const buttons = [
      ...node.querySelectorAll('button:not(:disabled)'),
    ] as HTMLElement[];
    const at = buttons.indexOf(e.target as HTMLElement);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  });

  return node;
}

function bannerNode(
  state: ViewState,
  ui: Ui,
  actions: Actions,
): HTMLElement | null {
  const model = bannerFor(state);
  if (!model || state.kind !== 'ready') return null;

  const run = (action: BannerAction) => {
    if (action === 'reconnect') actions.connect();
    else if (action === 'review-conflict')
      actions.open({ kind: 'conflict', choices: {} }, 'banner-action');
    else if (action === 'send') actions.send();
    else if (action === 'sync') actions.sync();
    else actions.openGitHub(`${repoUrl(state.repository)}/issues`);
  };

  return banner({
    tone: model.tone,
    icon: model.icon,
    title: model.title,
    text: model.text,
    alert: ui.alert && !!model.problem,
    ...(model.details ? { details: model.details } : {}),
    actions: model.actions.map((a, i) =>
      button(a.label, () => run(a.action), {
        kind: a.primary ? 'primary' : '',
        sm: true,
        disabled: !!state.busy && a.action !== 'open-github',
        ...(i === model.actions.length - 1
          ? { 'data-key': 'banner-action' }
          : {}),
      }),
    ),
  });
}

// ---------------------------------------------------------------- setup

function noProxy(): HTMLElement {
  return empty(
    'server',
    'This Atomic Server can’t reach GitHub or Jira for apps.',
    'Ask its admin to update Atomic Server. Nothing was fetched.',
    undefined,
    true,
  );
}

function sources(state: ViewState, actions: Actions): HTMLElement {
  const connecting = state.kind === 'connecting';
  const row = (
    name: string,
    scope: string,
    effect: string,
    action: Child,
    disabled = false,
  ) =>
    h(
      'li',
      { class: `src${disabled ? ' disabled' : ''}` },
      h(
        'div',
        { class: 'src-text' },
        h('b', null, name),
        h('span', null, scope),
        h('span', { class: 'effect' }, effect),
      ),
      action,
    );

  return h(
    'div',
    { class: 'center-wrap' },
    h(
      'div',
      { class: 'onboard' },
      h('h2', null, 'Bring your issues into this drive'),
      h(
        'p',
        { class: 'lede' },
        'Pick where your issues live today. They stay there; this board mirrors them into an Atomic table you can link, search and query.',
      ),
      h(
        'ul',
        { class: 'srcs' },
        row(
          'GitHub Issues',
          'One repository’s issues and comments.',
          'Two-way: status, title, description and comments are sent back to GitHub after you review them.',
          button(connecting ? 'Waiting…' : 'Connect', () => actions.connect(), {
            kind: 'primary',
            'aria-label': 'Connect GitHub Issues',
            'data-key': 'connect-github',
            disabled: connecting,
          }),
        ),
        row(
          'Jira',
          'One Jira Cloud project.',
          'Read-only for now: nothing is sent back to Jira.',
          h(
            'span',
            { class: 'muted small' },
            'Not available on this server yet',
          ),
          true,
        ),
        row(
          'Todoist',
          'One Todoist project’s tasks.',
          'Read-only: nothing is sent back to Todoist.',
          h('span', { class: 'muted small' }, 'Not available in this app yet'),
          true,
        ),
      ),
      h(
        'p',
        { class: 'fine' },
        connecting
          ? 'Confirm the connection in the bar Atomic Server shows above this app.'
          : 'Connecting opens a confirmation bar from Atomic Server, then your provider’s sign-in. This app never sees your password or token.',
      ),
    ),
  );
}

function repoLine(repo: Repository): string {
  if (!repo.hasIssues) return 'issues disabled';
  if (repo.openIssues === undefined) return '';
  if (repo.openIssues === 0) return 'no open issues';

  return `about ${repo.openIssues} open ${repo.openIssues === 1 ? 'issue' : 'issues'}`;
}

function chooseRepository(
  state: Extract<ViewState, { kind: 'choose-repository' }>,
  ui: Ui,
  actions: Actions,
): HTMLElement {
  const listing: RepositoryListing | undefined = state.listing;
  const listed = listing?.kind === 'listed' ? listing.repositories : undefined;
  const typed = !listed || listed.length === 0;
  const choice = typed ? ui.typedRepo.trim() : ui.repoChoice;
  const busy = !!state.settingUp;
  let body: Child;

  if (!listing || listing.kind === 'loading') {
    body = h(
      'p',
      { class: 'lede' },
      'Loading the repositories this connection can see…',
    );
  } else if (listed && listed.length) {
    const q = ui.repoFilter.toLowerCase();
    const shown = listed.filter(r => r.fullName.toLowerCase().includes(q));
    const { field } = searchField(
      `Filter ${listed.length} ${listed.length === 1 ? 'repository' : 'repositories'}`,
      ui.repoFilter,
      value => actions.setUi({ repoFilter: value }),
      true,
    );
    field.dataset.key = 'repo-filter';
    field.querySelector('input')!.dataset.key = 'repo-filter-input';
    field.querySelector('kbd')?.remove();
    body = [
      field,
      h(
        'ul',
        { class: 'repos', role: 'radiogroup', 'aria-label': 'Repositories' },
        shown.map(repo =>
          h(
            'li',
            null,
            h(
              'label',
              { class: `repo${repo.hasIssues ? '' : ' disabled'}` },
              h('input', {
                type: 'radio',
                name: 'repository',
                value: repo.fullName,
                checked: ui.repoChoice === repo.fullName,
                disabled: !repo.hasIssues || busy,
                'data-key': `repo:${repo.fullName}`,
                onchange: () => actions.setUi({ repoChoice: repo.fullName }),
              }),
              h('span', { class: 'mono' }, repo.fullName),
              h('span', { class: 'muted small' }, repoLine(repo)),
            ),
          ),
        ),
      ),
      shown.length
        ? null
        : h('p', { class: 'fine' }, 'No repository matches this filter.'),
    ];
  } else {
    const input = h('input', {
      name: 'repository',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'octocat/hello-world',
      'aria-label': 'Repository (owner/name)',
      'data-key': 'typed-repo',
      disabled: busy,
      oninput: event =>
        actions.setUi(
          { typedRepo: (event.target as HTMLInputElement).value },
          false,
        ),
      onkeydown: event => {
        if ((event as KeyboardEvent).key === 'Enter')
          actions.choose((event.target as HTMLInputElement).value);
      },
    });
    input.value = ui.typedRepo;
    body = [
      h(
        'p',
        { class: 'lede' },
        listing.kind === 'unavailable'
          ? 'This connection could not list your repositories here, so type the one to import.'
          : 'This connection sees no repositories. Type the one to import.',
      ),
      h(
        'div',
        { class: 'typed' },
        h(
          'label',
          { class: 'search' },
          h('span', { class: 'sr' }, 'Repository (owner/name)'),
          input,
        ),
      ),
      listing.kind === 'unavailable'
        ? h(
            'details',
            { class: 'b-details', style: 'margin:0' },
            h('summary', null, 'Details'),
            h('code', null, listing.message),
          )
        : null,
    ];
  }

  const target = choice || 'repository';

  return h(
    'div',
    { class: 'center-wrap' },
    h(
      'div',
      { class: 'onboard' },
      h('h2', null, 'Which repository?'),
      body,
      state.error
        ? h('p', { class: 'field-error', role: 'alert' }, state.error)
        : null,
      h(
        'div',
        { class: 'effects' },
        h('h3', null, 'What this board will do on GitHub'),
        h(
          'ul',
          null,
          h(
            'li',
            null,
            'Moving a card to ',
            h('b', null, 'Done'),
            ' closes the issue. Moving it back reopens it.',
          ),
          h(
            'li',
            null,
            'Moving a card to ',
            h('b', null, 'Doing'),
            ' adds the ',
            h('code', null, 'atomic:doing'),
            ' label; leaving Doing removes it. Other labels are never touched.',
          ),
          h(
            'li',
            null,
            'Title, description and comment edits are sent to GitHub, and new cards become new issues, each only after you review and send it.',
          ),
          h(
            'li',
            null,
            'Nothing is ever deleted on GitHub. One app syncs one repository.',
          ),
        ),
      ),
      h(
        'div',
        { class: 'actions-row' },
        button(
          busy ? `Setting up ${state.settingUp}…` : `Import ${target}`,
          () => choice && actions.choose(choice),
          { kind: 'primary', disabled: busy || !choice, 'data-key': 'import' },
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- board

function marker(kind: Marker | undefined): HTMLElement | null {
  if (!kind) return null;
  if (kind === 'conflict')
    return h(
      'span',
      { class: 'sync-mark conflict', title: MARKER_TEXT.conflict },
      icon('warn', 14),
      h('span', { class: 'sr' }, MARKER_TEXT.conflict),
    );

  return h(
    'span',
    { class: `sync-mark ${kind}`, title: MARKER_TEXT[kind] },
    h('span', { class: 'sr' }, MARKER_TEXT[kind]),
  );
}

function chipsFor(row: IssueRow, max: number): HTMLElement | null {
  if (!row.labels.length) return null;
  const shown = row.labels.slice(0, max);
  const rest = row.labels.length - shown.length;

  return h(
    'span',
    { class: 'chips' },
    shown.map(l => chip(l.name, l.color)),
    rest > 0
      ? h(
          'span',
          {
            class: 'chip more',
            title: row.labels
              .slice(max)
              .map(l => l.name)
              .join(', '),
          },
          `+${rest}`,
        )
      : null,
  );
}

function commentCount(row: IssueRow): HTMLElement | null {
  const n = row.comments.length;
  if (!n) return null;

  return h(
    'span',
    { class: 'cmt', title: `${n} ${n === 1 ? 'comment' : 'comments'}` },
    icon('comment', 13),
    h('span', { 'aria-hidden': 'true' }, String(n)),
    h('span', { class: 'sr' }, `${n} ${n === 1 ? 'comment' : 'comments'}`),
  );
}

function moveMenu(
  row: IssueRow,
  actions: Actions,
  movable: boolean,
): HTMLElement {
  return menu(
    `Move ${refOf(row)} to`,
    STATUSES.map(status => ({
      label: status,
      glyph: GLYPH[status],
      checked: row.status === status,
      disabled: !movable || row.status === status,
      run: () => actions.move(row.subject, status, 'menu'),
    })),
    actions,
  );
}

function card(
  row: IssueRow,
  state: Ready,
  ui: Ui,
  marks: Map<string, Marker>,
  actions: Actions,
): HTMLElement {
  const movable = canMove(state) && !state.busy;
  const menuId = `move:${row.subject}`;
  const open = ui.menu === menuId;
  const selected =
    ui.panel?.kind === 'issue' && ui.panel.subject === row.subject;
  const li = h(
    'li',
    {
      class: `card${selected ? ' is-selected' : ''}${ui.flash.has(row.subject) ? ' flash' : ''}`,
      'data-subject': row.subject,
      draggable: movable ? 'true' : 'false',
      ondragstart: event => {
        const e = event as DragEvent;
        e.dataTransfer?.setData('text/plain', row.subject);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        (e.currentTarget as HTMLElement).classList.add('dragging');
      },
      ondragend: event =>
        (event.currentTarget as HTMLElement).classList.remove('dragging'),
    },
    h(
      'button',
      {
        type: 'button',
        class: 'card-hit',
        'data-key': `card:${row.subject}`,
        'data-issue': row.subject,
        onclick: () =>
          actions.open(
            { kind: 'issue', subject: row.subject },
            `card:${row.subject}`,
          ),
        onfocus: () => actions.setUi({ focus: row.subject }, false),
      },
      h(
        'span',
        { class: 'card-top' },
        h('span', { class: 'ref' }, refOf(row)),
        h('span', { class: 'sr' }, `Status: ${row.status}.`),
        marker(marks.get(row.subject)),
      ),
      h('span', { class: 'card-title' }, row.title),
      row.labels.length || row.comments.length
        ? h('span', { class: 'card-foot' }, chipsFor(row, 3), commentCount(row))
        : null,
    ),
    iconButton(
      'more',
      `Move ${refOf(row)} to…`,
      () => actions.setUi({ menu: open ? undefined : menuId }),
      {
        sm: true,
        class: 'icon-btn sm card-menu',
        'aria-haspopup': 'menu',
        'aria-expanded': String(open),
        'data-key': `cardmenu:${row.subject}`,
      },
    ),
    open ? moveMenu(row, actions, movable) : null,
  );

  return li;
}

function skeletonCard(): HTMLElement {
  return h(
    'li',
    { class: 'card skel', 'aria-hidden': 'true' },
    h('span', { class: 'sk', style: 'width:22%' }),
    h('span', { class: 'sk', style: 'width:86%' }),
    h('span', { class: 'sk', style: 'width:54%' }),
  );
}

function board(state: Ready, ui: Ui, actions: Actions): HTMLElement {
  const rows = state.last?.result.rows ?? [];
  const importing = state.busy === 'syncing' && !state.last;
  const filter: Filter = { search: ui.search, label: ui.label };
  const cols = columns(rows, filter, ui.allDone);
  const marks = markers(state);
  const movable = canMove(state) && !state.busy;

  return h(
    'div',
    { class: 'board', 'data-scroll': 'board' },
    cols.map(col => {
      const section = h(
        'section',
        {
          class: 'col',
          'aria-labelledby': `col-${col.status}`,
          'data-status': col.status,
          ondragover: event => {
            if (!movable) return;
            event.preventDefault();
            (event.currentTarget as HTMLElement).classList.add('drop');
          },
          ondragleave: event =>
            (event.currentTarget as HTMLElement).classList.remove('drop'),
          ondrop: event => {
            const e = event as DragEvent;
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.remove('drop');
            const subject = e.dataTransfer?.getData('text/plain');
            if (subject && movable) actions.move(subject, col.status, 'drag');
          },
        },
        h(
          'header',
          { class: 'col-head' },
          statusGlyph(GLYPH[col.status]),
          h('h2', { id: `col-${col.status}` }, col.status),
          h('span', { class: 'count' }, importing ? '…' : String(col.total)),
          iconButton(
            'plus',
            `New issue in ${col.status}`,
            () => {
              actions.setDrafts({ newStatus: col.status }, false);
              actions.open({ kind: 'new' }, `colnew:${col.status}`);
            },
            { sm: true, 'data-key': `colnew:${col.status}` },
          ),
        ),
        h(
          'ul',
          {
            class: 'cards',
            role: 'list',
            'aria-labelledby': `col-${col.status}`,
          },
          col.rows.map(row => card(row, state, ui, marks, actions)),
          importing ? [skeletonCard(), skeletonCard()] : null,
        ),
        col.hidden
          ? h(
              'button',
              {
                type: 'button',
                class: 'show-more',
                'data-key': 'show-more',
                onclick: () => actions.setUi({ allDone: true }),
              },
              `Show ${col.hidden} more`,
            )
          : col.status === 'Done' && ui.allDone && col.total > 20
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'show-more',
                  'data-key': 'show-more',
                  onclick: () => actions.setUi({ allDone: false }),
                },
                'Show fewer',
              )
            : null,
      );

      return section;
    }),
  );
}

// ---------------------------------------------------------------- list

const LIST_ORDER: Status[] = ['Doing', 'Todo', 'Done'];

function list(state: Ready, ui: Ui, actions: Actions): HTMLElement {
  const rows = state.last?.result.rows ?? [];
  const filter: Filter = { search: ui.search, label: ui.label };
  const cols = columns(rows, filter, ui.allDone);
  const marks = markers(state);
  const movable = canMove(state) && !state.busy;

  return h(
    'div',
    { class: 'list' },
    LIST_ORDER.map(status => {
      const col = cols.find(c => c.status === status)!;
      const expanded = ui.groups[status] ?? status !== 'Done';
      const id = `group-${status}`;

      return h(
        'section',
        { class: 'group' },
        h(
          'button',
          {
            type: 'button',
            class: 'group-head',
            id,
            'aria-expanded': String(expanded),
            'data-key': id,
            onclick: () =>
              actions.setUi({ groups: { ...ui.groups, [status]: !expanded } }),
          },
          icon('chevron', 12),
          statusGlyph(GLYPH[status]),
          h('span', null, status),
          h('span', { class: 'count' }, String(col.total)),
        ),
        expanded
          ? h(
              'ul',
              { class: 'rows', role: 'list', 'aria-labelledby': id },
              col.rows.map(row => {
                const menuId = `status:${row.subject}`;
                const open = ui.menu === menuId;
                const selected =
                  ui.panel?.kind === 'issue' &&
                  ui.panel.subject === row.subject;

                return h(
                  'li',
                  {
                    class: `row${selected ? ' is-selected' : ''}`,
                    'data-subject': row.subject,
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'glyph-btn',
                      'aria-label': `Status: ${row.status}. Change status of ${refOf(row)}`,
                      'aria-haspopup': 'menu',
                      'aria-expanded': String(open),
                      'data-key': `glyph:${row.subject}`,
                      onclick: () =>
                        actions.setUi({ menu: open ? undefined : menuId }),
                    },
                    statusGlyph(GLYPH[row.status], 16),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'row-hit',
                      'data-key': `card:${row.subject}`,
                      'data-issue': row.subject,
                      onclick: () =>
                        actions.open(
                          { kind: 'issue', subject: row.subject },
                          `card:${row.subject}`,
                        ),
                      onfocus: () =>
                        actions.setUi({ focus: row.subject }, false),
                    },
                    h(
                      'span',
                      { class: 'row-line' },
                      h('span', { class: 'ref' }, refOf(row)),
                      marker(marks.get(row.subject)),
                      h(
                        'span',
                        { class: 'when' },
                        short(row.updatedAt, ui.now),
                      ),
                    ),
                    h('span', { class: 'row-title' }, row.title),
                    row.labels.length || row.comments.length
                      ? h(
                          'span',
                          { class: 'row-foot' },
                          chipsFor(row, 2),
                          commentCount(row),
                        )
                      : null,
                  ),
                  open ? moveMenu(row, actions, movable) : null,
                );
              }),
            )
          : null,
        expanded && col.hidden
          ? h(
              'button',
              {
                type: 'button',
                class: 'show-more',
                style: 'margin:4px 12px',
                'data-key': 'show-more',
                onclick: () => actions.setUi({ allDone: true }),
              },
              `Show ${col.hidden} more`,
            )
          : null,
      );
    }),
  );
}

// ---------------------------------------------------------------- toolbar

function toolbar(
  state: Ready,
  ui: Ui,
  layout: Layout,
  actions: Actions,
): HTMLElement {
  const rows = state.last?.result.rows ?? [];
  const labels = labelNames(rows);
  const small = ui.size === 's';
  const { field, input } = searchField('Search issues', ui.search, value =>
    actions.setUi({ search: value }),
  );
  input.dataset.key = 'search';
  input.id = 'issue-search';
  const menuOpen = ui.menu === 'label';

  return h(
    'div',
    { class: 'toolbar' },
    segmented<Layout>(
      'Layout',
      [
        {
          value: 'board',
          label: small ? [] : 'Board',
          iconName: 'board',
          title: 'Board',
        },
        {
          value: 'list',
          label: small ? [] : 'List',
          iconName: 'list',
          title: 'List',
        },
      ],
      layout,
      value => actions.setUi({ layout: value }),
    ),
    field,
    small
      ? null
      : h(
          'span',
          { class: 'tb-menu label-menu' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost',
              'aria-haspopup': 'menu',
              'aria-expanded': String(menuOpen),
              'data-key': 'label-filter',
              disabled: !labels.length && !ui.label,
              onclick: () =>
                actions.setUi({ menu: menuOpen ? undefined : 'label' }),
            },
            ui.label ? `Label: ${ui.label}` : 'Label',
            icon('chevron', 10),
          ),
          menuOpen
            ? menu(
                'Filter by label',
                [
                  {
                    label: 'Any label',
                    checked: !ui.label,
                    run: () => actions.setUi({ label: undefined }),
                  },
                  ...labels.map(name => ({
                    label: name,
                    checked: ui.label === name,
                    run: () => actions.setUi({ label: name }),
                  })),
                ],
                actions,
              )
            : null,
        ),
    small
      ? null
      : h(
          'span',
          { class: 'tb-count' },
          state.busy === 'syncing' && !state.last
            ? 'Importing…'
            : countText(rows, { search: ui.search, label: ui.label }),
        ),
  );
}

function emptyContent(
  state: Ready,
  ui: Ui,
  actions: Actions,
): HTMLElement | null {
  const rows = state.last?.result.rows ?? [];
  if (!state.last) return null;
  const filter: Filter = { search: ui.search, label: ui.label };

  if (!rows.length)
    return empty(
      'inbox',
      `No issues in ${state.repository} yet.`,
      'Create one here and it goes to GitHub once you review and send it.',
      button('New issue', () => actions.open({ kind: 'new' }, 'empty-new'), {
        kind: 'primary',
        iconName: 'plus',
        'data-key': 'empty-new',
      }),
      true,
    );

  if (filtering(filter) && !rows.some(r => matches(r, filter))) {
    const what = [
      ui.search.trim() ? `“${ui.search.trim()}”` : '',
      ui.label ? `label ${ui.label}` : '',
    ]
      .filter(Boolean)
      .join(' with ');

    return empty(
      'filter',
      `No issues match ${what}.`,
      `${rows.length} ${rows.length === 1 ? 'issue is' : 'issues are'} hidden by these filters.`,
      button(
        'Clear filters',
        () => actions.setUi({ search: '', label: undefined }),
        { 'data-key': 'clear-filters' },
      ),
      true,
    );
  }

  return null;
}

// ---------------------------------------------------------------- detail

function initials(login?: string) {
  return (login ?? '?').replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?';
}

function detailBar(
  label: Child,
  mode: DetailMode,
  actions: Actions,
): HTMLElement {
  const close = () => actions.open(undefined);

  return h(
    'div',
    { class: 'd-bar' },
    mode === 'sheet'
      ? iconButton('back', 'Back to issues', close, {
          'data-key': 'detail-close',
        })
      : null,
    h('span', { class: 'ref' }, label),
    h('span', { class: 'spacer' }),
    mode === 'sheet'
      ? null
      : iconButton('close', 'Close', close, { 'data-key': 'detail-close' }),
  );
}

function statusControl(
  value: Status,
  onchange: (s: Status) => void,
  disabled: boolean,
): HTMLElement {
  return segmented<Status>(
    'Status',
    STATUSES.map(s => ({ value: s, label: [statusGlyph(GLYPH[s]), s] })),
    value,
    onchange,
    { mode: 'radio', disabled, cls: 'status-seg' },
  );
}

function issueDetail(
  row: IssueRow,
  state: Ready,
  ui: Ui,
  mode: DetailMode,
  actions: Actions,
): HTMLElement[] {
  const d = ui.drafts;
  const movable = canMove(state);
  const pending = pendingComments(state);
  const marks = markers(state);
  /** Enter already saved; the blur it causes must not save again. */
  let titleDone = false;
  const title = h('textarea', {
    class: 'd-title',
    rows: 1,
    'aria-label': 'Title',
    'data-key': 'detail-title',
    oninput: event =>
      actions.setDrafts(
        { title: (event.target as HTMLTextAreaElement).value },
        false,
      ),
    onkeydown: event => {
      const e = event as KeyboardEvent;
      const t = e.target as HTMLTextAreaElement;

      if (e.key === 'Enter') {
        e.preventDefault();
        const next = t.value.trim();
        titleDone = true;
        if (next && next !== row.title) actions.saveTitle(row.subject, next);
        else actions.setDrafts({ title: undefined });
        t.blur();
      } else if (e.key === 'Escape' && t.value !== row.title) {
        // Reverts an edit; an unedited title lets Esc close the panel.
        e.preventDefault();
        e.stopPropagation();
        t.value = row.title;
        actions.setDrafts({ title: undefined });
      }
    },
    onblur: event => {
      const next = (event.target as HTMLTextAreaElement).value.trim();
      if (!titleDone && next && next !== row.title)
        actions.saveTitle(row.subject, next);
      titleDone = false;
    },
  });
  title.value = d.title ?? row.title;

  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Description' },
    (['write', 'preview'] as const).map(tab =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(d.tab === tab),
          'data-key': `tab:${tab}`,
          onclick: () =>
            actions.setDrafts({
              tab,
              ...(tab === 'write' && d.body === undefined
                ? { body: row.body }
                : {}),
            }),
        },
        tab === 'write' ? 'Write' : 'Preview',
      ),
    ),
  );
  let description: Child;

  if (d.tab === 'write') {
    const editor = h('textarea', {
      class: 'editor',
      'aria-label': 'Description (Markdown)',
      'data-key': 'detail-body',
      oninput: event =>
        actions.setDrafts(
          { body: (event.target as HTMLTextAreaElement).value },
          false,
        ),
    });
    editor.value = d.body ?? row.body;
    description = [
      editor,
      h(
        'div',
        { class: 'row-actions' },
        button(
          'Cancel',
          () => actions.setDrafts({ tab: 'preview', body: undefined }),
          {
            sm: true,
          },
        ),
        button(
          'Save description',
          () => actions.saveBody(row.subject, editor.value),
          { sm: true, kind: 'primary', 'data-key': 'save-body' },
        ),
      ),
    ];
  } else {
    const md = h('div', { class: 'md' });
    if (row.body.trim()) md.append(markdown(row.body));
    else md.append(h('p', { class: 'md-empty' }, 'No description.'));
    description = md;
  }

  const comments = h(
    'ul',
    { class: 'comments' },
    row.comments.map(c => {
      const waiting = pending.has(c.subject) || !c.author;

      return h(
        'li',
        { class: waiting ? 'pending' : '' },
        h(
          'span',
          { class: `avatar${c.author ? '' : ' me'}`, 'aria-hidden': 'true' },
          c.author ? initials(c.author) : 'You'.slice(0, 2),
        ),
        h(
          'div',
          null,
          h(
            'p',
            { class: 'c-meta' },
            c.author
              ? [
                  h('b', null, c.author),
                  ' on GitHub',
                  c.createdAt ? ` · ${ago(c.createdAt, ui.now)}` : '',
                ]
              : [
                  h('b', null, 'You'),
                  ' · ',
                  h(
                    'span',
                    { class: 'pend' },
                    state.busy === 'sending' ? 'Sending' : 'Waiting to send',
                  ),
                ],
          ),
          h('div', { class: 'md' }, markdown(c.body)),
        ),
      );
    }),
  );
  const composer = h('textarea', {
    placeholder: 'Add a comment… (Markdown)',
    'aria-label': 'Add a comment',
    'data-key': 'composer',
    rows: 3,
    oninput: event => {
      const value = (event.target as HTMLTextAreaElement).value;
      // Kept without a re-render; only the button follows the text.
      actions.setDrafts({ comment: value }, false);
      send.disabled = !value.trim();
    },
    onkeydown: event => {
      const e = event as KeyboardEvent;

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        actions.comment(row.subject, (e.target as HTMLTextAreaElement).value);
      }
    },
  });
  composer.value = d.comment;
  const send = button(
    'Comment',
    () => actions.comment(row.subject, composer.value),
    {
      kind: 'primary',
      sm: true,
      disabled: !d.comment.trim(),
      'data-key': 'comment',
    },
  );
  const bound = row.number !== undefined;
  const mark = marks.get(row.subject);

  const body = h(
    'div',
    { class: 'd-body' },
    title,
    h(
      'div',
      { class: 'd-props' },
      h('span', { class: 'd-k' }, 'Status'),
      statusControl(
        row.status,
        s => s !== row.status && actions.move(row.subject, s, 'menu'),
        !movable || !!state.busy,
      ),
      h('span', { class: 'd-k' }, 'Labels'),
      h(
        'span',
        { class: 'chips' },
        row.labels.map(l => chip(l.name, l.color)),
        h(
          'span',
          { class: 'muted small' },
          row.labels.length
            ? 'Labels are edited on GitHub'
            : 'None · edited on GitHub',
        ),
      ),
      row.assignees.length ? h('span', { class: 'd-k' }, 'Assignees') : null,
      row.assignees.length
        ? h('span', { class: 'small' }, row.assignees.join(', '))
        : null,
    ),
    mark
      ? h(
          'p',
          { class: 'ro-note' },
          icon(mark === 'conflict' ? 'warn' : 'info', 14),
          mark === 'conflict'
            ? 'Changed here and on GitHub; review the conflict to resume sync.'
            : 'Changes to this issue are waiting to send. Review and send them from the bar above.',
        )
      : null,
    h('h3', { class: 'd-h' }, 'Description'),
    tabs,
    description,
    h(
      'h3',
      { class: 'd-h' },
      'Comments',
      h('span', { class: 'count' }, String(row.comments.length)),
    ),
    row.comments.length
      ? comments
      : h('p', { class: 'muted small', style: 'margin:0' }, 'No comments yet.'),
    h(
      'div',
      { class: 'composer' },
      composer,
      h(
        'div',
        { class: 'cmp-row' },
        h(
          'span',
          { class: 'muted small' },
          bound
            ? 'Sent to GitHub after you review it'
            : 'Sent once the issue is on GitHub',
        ),
        send,
      ),
    ),
  );

  const foot = h(
    'div',
    { class: 'd-foot' },
    h(
      'span',
      { class: 'mono' },
      bound
        ? `${state.repository}#${row.number}`
        : `${state.repository} · not on GitHub yet`,
    ),
    state.last?.at ? ` · synced ${ago(state.last.at, ui.now)}` : '',
    row.url
      ? [
          ' · ',
          h(
            'a',
            { href: row.url, target: '_blank', rel: 'noopener noreferrer' },
            'Open on GitHub',
            icon('external', 12),
          ),
        ]
      : null,
  );

  return [
    detailBar(bound ? `#${row.number}` : 'New issue', mode, actions),
    body,
    foot,
  ];
}

function newDetail(
  state: Ready,
  ui: Ui,
  mode: DetailMode,
  actions: Actions,
): HTMLElement[] {
  const d = ui.drafts;
  const title = h('textarea', {
    class: 'd-title',
    rows: 1,
    placeholder: 'Title',
    'aria-label': 'Title',
    'data-key': 'new-title',
    oninput: event =>
      actions.setDrafts({
        newTitle: (event.target as HTMLTextAreaElement).value,
      }),
    onkeydown: event => {
      const e = event as KeyboardEvent;

      if (e.key === 'Enter') {
        e.preventDefault();
        if (d.newTitle.trim()) actions.create();
      }
    },
  });
  title.value = d.newTitle;
  const editor = h('textarea', {
    class: 'editor',
    placeholder: 'Description (Markdown)',
    'aria-label': 'Description (Markdown)',
    'data-key': 'new-body',
    oninput: event =>
      actions.setDrafts(
        { newBody: (event.target as HTMLTextAreaElement).value },
        false,
      ),
  });
  editor.value = d.newBody;

  return [
    detailBar('New issue', mode, actions),
    h(
      'div',
      { class: 'd-body' },
      title,
      h(
        'div',
        { class: 'd-props' },
        h('span', { class: 'd-k' }, 'Status'),
        statusControl(
          d.newStatus,
          s => actions.setDrafts({ newStatus: s }),
          false,
        ),
      ),
      h('h3', { class: 'd-h' }, 'Description'),
      editor,
      h(
        'p',
        { class: 'ro-note' },
        icon('info', 14),
        `Created in this table first. It becomes an issue in ${state.repository} once you review and send it.`,
      ),
    ),
    h(
      'div',
      { class: 'd-actions' },
      button('Cancel', () => actions.open(undefined)),
      button('Create issue', () => actions.create(), {
        kind: 'primary',
        disabled: !d.newTitle.trim() || !!state.busy,
        'data-key': 'create',
      }),
    ),
  ];
}

function reviewDetail(
  state: Ready,
  mode: DetailMode,
  actions: Actions,
): HTMLElement[] {
  const held = state.last?.result.held ?? [];
  const n = held.length;

  return [
    detailBar('Waiting to send', mode, actions),
    h(
      'section',
      { class: 'd-body', 'aria-label': 'Changes to send to GitHub' },
      h(
        'h2',
        { class: 'd-title ro' },
        n
          ? `Send ${n} ${n === 1 ? 'change' : 'changes'} to GitHub?`
          : 'Nothing is waiting',
      ),
      h(
        'p',
        { class: 'muted small', style: 'margin:0' },
        'Nothing reaches GitHub until you send it. A change edited after this review is held again.',
      ),
      n
        ? h(
            'ol',
            { class: 'review' },
            held.map(x => h('li', null, describeHeld(x))),
          )
        : null,
    ),
    h(
      'div',
      { class: 'd-actions' },
      button('Not now', () => actions.open(undefined)),
      button(
        `Send ${n} ${n === 1 ? 'change' : 'changes'} to GitHub`,
        () => actions.send(),
        {
          kind: 'primary',
          disabled: !n || !!state.busy,
          'data-key': 'send',
        },
      ),
    ),
  ];
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  body: 'Description',
  status: 'Status',
};

function conflictValue(
  field: string,
  value: unknown,
  other: unknown,
): HTMLElement {
  if (field === 'status' && typeof value === 'string' && value in GLYPH)
    return h(
      'span',
      { class: 'cf-val' },
      statusGlyph(GLYPH[value as Status]),
      value,
    );
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const theirs = typeof other === 'string' ? other : '';
  // Highlight the part that differs: common prefix and suffix stay plain.
  let start = 0;
  while (start < text.length && text[start] === theirs[start]) start++;
  let end = 0;
  while (
    end < text.length - start &&
    text[text.length - 1 - end] === theirs[theirs.length - 1 - end]
  )
    end++;
  const middle = text.slice(start, text.length - end);

  return h(
    'span',
    { class: 'cf-val' },
    text.slice(0, start),
    middle ? h('ins', null, middle) : null,
    text.slice(text.length - end),
    text ? null : h('span', { class: 'muted' }, '(empty)'),
  );
}

function conflictDetail(
  state: Ready,
  panel: Extract<Panel, { kind: 'conflict' }>,
  mode: DetailMode,
  actions: Actions,
): HTMLElement[] {
  const p = state.problem?.kind === 'conflict' ? state.problem : undefined;
  const row = state.last?.result.rows.find(r => r.subject === p?.local);
  const fields = panel.fields ?? [];
  const missing = fields.filter(f => !panel.choices[f.field]);
  let body: Child;

  if (!p) body = h('p', null, 'This conflict is settled.');
  else if (panel.error) body = h('p', { class: 'field-error' }, panel.error);
  else if (!panel.fields)
    body = h('p', { class: 'muted' }, 'Reading both versions…');
  else
    body = [
      h(
        'p',
        { class: 'muted small', style: 'margin:0' },
        'Pick which version to keep for each field. Nothing is sent or saved until you apply.',
      ),
      fields.map(f =>
        h(
          'fieldset',
          { class: 'cf' },
          h('legend', null, FIELD_NAMES[f.field] ?? f.field),
          (['local', 'remote'] as const).map(side =>
            h(
              'label',
              { class: 'cf-opt' },
              h('input', {
                type: 'radio',
                name: `cf-${f.field}`,
                value: side,
                checked: panel.choices[f.field] === side,
                'data-key': `cf:${f.field}:${side}`,
                onchange: () =>
                  actions.open({
                    ...panel,
                    choices: { ...panel.choices, [f.field]: side },
                  }),
              }),
              h(
                'span',
                { class: 'cf-src' },
                side === 'local' ? 'Here' : 'On GitHub',
              ),
              conflictValue(
                f.field,
                f[side],
                side === 'local' ? f.remote : f.local,
              ),
            ),
          ),
        ),
      ),
      h(
        'p',
        { class: 'muted small', style: 'margin:0' },
        'Other fields and comments did not conflict and will sync normally. Keeping “Here” for a field becomes a change you review before it is sent.',
      ),
    ];

  return [
    detailBar('Conflict', mode, actions),
    h(
      'div',
      { class: 'd-body' },
      h(
        'h2',
        { class: 'd-title ro' },
        row ? `${refOf(row)} ${row.title}` : 'Changed on both sides',
      ),
      body,
    ),
    h(
      'div',
      { class: 'd-actions' },
      button('Apply and resume sync', () => actions.resolve(), {
        kind: 'primary',
        disabled: !p || !panel.fields || missing.length > 0 || !!state.busy,
        'data-key': 'apply',
      }),
      missing.length && panel.fields
        ? h(
            'p',
            { class: 'hint muted small' },
            `Choose ${missing.map(f => FIELD_NAMES[f.field] ?? f.field).join(' and ')} first`,
          )
        : null,
    ),
  ];
}

export function detail(
  state: Ready,
  ui: Ui,
  mode: DetailMode,
  actions: Actions,
): HTMLElement | null {
  const panel = ui.panel;
  if (!panel) return null;
  let content: HTMLElement[] | undefined;
  let label = 'Issue';

  if (panel.kind === 'issue') {
    const row = state.last?.result.rows.find(r => r.subject === panel.subject);
    if (!row) return null;
    content = issueDetail(row, state, ui, mode, actions);
    label = `${refOf(row)} ${row.title}`;
  } else if (panel.kind === 'new') {
    content = newDetail(state, ui, mode, actions);
    label = 'New issue';
  } else if (panel.kind === 'review') {
    content = reviewDetail(state, mode, actions);
    label = 'Changes to send';
  } else {
    content = conflictDetail(state, panel, mode, actions);
    label = 'Conflict review';
  }

  return h(
    'aside',
    {
      class: `detail ${mode}`,
      'aria-label': label,
      ...(mode === 'docked' ? {} : { role: 'dialog', 'aria-modal': 'true' }),
      'data-panel': panel.kind,
    },
    content,
  );
}

function helpOverlay(actions: Actions): HTMLElement {
  return h(
    'div',
    {
      class: 'overlay',
      onclick: event => {
        if (event.target === event.currentTarget)
          actions.setUi({ help: false });
      },
    },
    h(
      'div',
      {
        class: 'dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'help-title',
      },
      h('h2', { id: 'help-title' }, 'Keyboard shortcuts'),
      h(
        'dl',
        { class: 'keys' },
        SHORTCUTS.map(([k, v]) => [
          h('dt', null, h('kbd', null, k)),
          h('dd', null, v),
        ]),
      ),
      h(
        'div',
        { class: 'actions-row' },
        button('Close', () => actions.setUi({ help: false }), {
          'data-key': 'help-close',
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- page

/** The whole page for a state; `main.ts` swaps it into the root. */
export function page(
  state: ViewState,
  ui: Ui,
  layout: Layout,
  mode: DetailMode,
  actions: Actions,
): HTMLElement[] {
  const top = appHeader(state, ui, actions);

  if (state.kind === 'no-proxy') return [top, noProxy()];
  if (state.kind === 'loading')
    return [
      top,
      h('p', { class: 'lede', style: 'padding:24px 16px' }, 'Loading…'),
    ];
  if (state.kind === 'not-connected' || state.kind === 'connecting')
    return [top, sources(state, actions)];
  if (state.kind === 'choose-repository')
    return [
      top,
      connectionBar([h('span', { class: 'acct' }, 'GitHub'), 'connected']),
      chooseRepository(state, ui, actions),
    ];

  const main = h(
    'div',
    { class: 'split-main' },
    bannerNode(state, ui, actions),
    toolbar(state, ui, layout, actions),
    emptyContent(state, ui, actions) ??
      (layout === 'board'
        ? board(state, ui, actions)
        : list(state, ui, actions)),
  );
  const panel = detail(state, ui, mode, actions);
  const body =
    panel && mode === 'docked'
      ? h('div', { class: 'split app-body' }, main, panel)
      : h('div', { class: 'app-body' }, main);
  const out: HTMLElement[] = [top, connBar(state, ui, actions), body];
  if (panel && mode !== 'docked')
    out.push(
      h('div', {
        class: 'scrim',
        'aria-hidden': 'true',
        onclick: () => actions.open(undefined),
      }),
      panel,
    );
  if (ui.help) out.push(helpOverlay(actions));

  return out;
}
