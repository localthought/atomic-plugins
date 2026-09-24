// @wc-ignore-file
/**
 * What the issue tracker shows, derived from a `ViewState` without a DOM:
 * the sync pill, the one banner, the connection-bar line, per-card sync
 * markers, filtering, columns and responsive defaults. `views.ts` turns
 * these into elements; the tests read them directly.
 */
import type { Problem, Ready, ViewState } from './controller.js';
import type { Held, IssueRow, Status } from './sync.js';
import type { IconName } from './ui/dom.js';
import type { PillState, Tone } from './ui/kit.js';
import type { Size } from './ui/theme.js';

export const STATUSES: Status[] = ['Todo', 'Doing', 'Done'];
/** Done shows this many most recently updated issues, then "Show N more". */
export const DONE_LIMIT = 20;

const MINUTE = 60_000;

/** "just now", "3 min ago", "2 h ago", "4 days ago", or a date. */
export function ago(at: number | string | undefined, now: number): string {
  const t = typeof at === 'string' ? Date.parse(at) : at;
  if (t === undefined || Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((now - t) / MINUTE));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;

  return new Date(t).toLocaleDateString();
}

/** The list's compact form: "now", "12m", "2h", "3d", "5w". */
export function short(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.floor((now - t) / MINUTE));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 1440 * 14) return `${Math.floor(m / 1440)}d`;

  return `${Math.floor(m / 10080)}w`;
}

export interface Pill {
  state: PillState;
  text: string;
}

/** The header's sync pill; undefined where the design shows none. */
export function pillFor(state: ViewState, now: number): Pill | undefined {
  switch (state.kind) {
    case 'loading':
      return { state: 'idle', text: 'Loading…' };
    case 'no-proxy':
      return undefined;
    case 'not-connected':
      return { state: 'idle', text: 'Not connected' };
    case 'connecting':
      return { state: 'syncing', text: 'Connecting…' };
    case 'choose-repository':
      return state.settingUp
        ? { state: 'syncing', text: 'Setting up…' }
        : { state: 'synced', text: 'Connected' };

    case 'ready': {
      if (state.busy === 'syncing' && !state.last)
        return { state: 'syncing', text: 'Importing…' };
      if (state.busy === 'sending')
        return { state: 'syncing', text: 'Sending…' };
      if (state.busy) return { state: 'syncing', text: 'Syncing…' };
      const p = state.problem;
      if (p?.kind === 'reconnect')
        return { state: 'reauth', text: 'Reconnect needed' };
      if (p?.kind === 'conflict' || p?.kind === 'paused')
        return { state: 'paused', text: 'Sync paused' };
      if (p?.kind === 'failed') return { state: 'error', text: 'Sync failed' };
      if (!state.last?.at) return { state: 'idle', text: 'Not synced yet' };

      return { state: 'synced', text: `Synced ${ago(state.last.at, now)}` };
    }
  }
}

export type BannerAction =
  | 'reconnect'
  | 'review-conflict'
  | 'send'
  | 'sync'
  | 'open-github'
  | 'keep-here'
  | 'remove'
  | 'confirm-remove'
  | 'cancel-remove';

export interface BannerModel {
  tone: Tone;
  icon: IconName;
  title: string;
  text: string;
  actions: {
    label: string;
    action: BannerAction;
    primary?: boolean;
    danger?: boolean;
  }[];
  details?: string;
  /** Set for problems; `views.ts` makes it an alert only when a sync raised it. */
  problem?: Problem;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Held writes that were let through once and got no answer. */
export const unconfirmed = (state: Ready): Held[] =>
  (state.last?.result.held ?? []).filter(h => h.unconfirmed);

/** The one banner under the connection bar, or none. Transient failures get none. */
export function bannerFor(
  state: ViewState,
  confirmingRemove = false,
): BannerModel | undefined {
  if (state.kind !== 'ready') return undefined;
  const p = state.problem;

  const ref = (subject?: string) => {
    const row = state.last?.result.rows.find(r => r.subject === subject);

    return row?.number ? `#${row.number}` : 'An issue';
  };

  if (p?.kind === 'conflict')
    return {
      tone: 'warn',
      icon: 'warn',
      title: 'Sync paused.',
      text: `${ref(p.local)} was changed both here and on GitHub since the last sync (${p.fields.join(', ')}). Nothing is sent or fetched until you choose.`,
      actions: [
        { label: 'Review conflict', action: 'review-conflict', primary: true },
      ],
      problem: p,
    };

  if (p?.kind === 'reconnect')
    return {
      tone: 'neg',
      icon: 'plug',
      title: 'GitHub no longer accepts this connection.',
      text: 'Your issues are still here. Changes you make are kept and sent after you reconnect.',
      actions: [
        { label: 'Reconnect GitHub', action: 'reconnect', primary: true },
      ],
      details: p.message,
      problem: p,
    };

  if (p?.kind === 'paused') {
    if (p.reason === 'uncertain')
      return {
        tone: 'warn',
        icon: 'info',
        title: 'A change was sent to GitHub, but no answer came back.',
        text: 'It may or may not have arrived. Check GitHub, then sync: the app reads GitHub back first, and it never sends a new issue twice.',
        actions: [
          { label: 'Check on GitHub', action: 'open-github' },
          { label: 'Sync now', action: 'sync', primary: true },
        ],
        details: p.message,
        problem: p,
      };
    if (p.reason === 'missing') {
      const issue =
        p.missing?.side === 'remote' && p.missing.entity === 'issue';
      const name = ref(p.missing?.local);

      if (issue && confirmingRemove)
        return {
          tone: 'warn',
          icon: 'ghost',
          title: `Remove ${name === 'An issue' ? 'this issue' : name} from this board?`,
          text: 'Its row and its comments are deleted from this table. Nothing on GitHub changes.',
          actions: [
            { label: 'Cancel', action: 'cancel-remove' },
            { label: 'Remove', action: 'confirm-remove', danger: true },
          ],
          details: p.message,
          problem: p,
        };

      return issue
        ? {
            tone: 'warn',
            icon: 'ghost',
            title: `${name} is on this board but no longer on GitHub.`,
            text: 'It may have been deleted or moved to another repository. Nothing on GitHub will change.',
            actions: [
              { label: 'Keep here only', action: 'keep-here' },
              { label: 'Remove from board', action: 'remove', danger: true },
            ],
            details: p.message,
            problem: p,
          }
        : {
            tone: 'warn',
            icon: 'ghost',
            title:
              p.missing?.side === 'local'
                ? 'A synced record was deleted from this table.'
                : 'A comment on this board is no longer on GitHub.',
            text: 'Sync is paused so nothing is deleted on the other side. Check GitHub and the table before syncing again.',
            actions: [
              { label: 'Check on GitHub', action: 'open-github' },
              { label: 'Sync now', action: 'sync' },
            ],
            details: p.message,
            problem: p,
          };
    }
    if (p.reason === 'rejected')
      return {
        tone: 'neg',
        icon: 'lock',
        title: 'Atomic Server refused to save a change.',
        text: 'You may not have write rights on this table. Ask the drive owner for access, then try again.',
        actions: [{ label: 'Try again', action: 'sync', primary: true }],
        details: p.message,
        problem: p,
      };

    return {
      tone: 'warn',
      icon: 'warn',
      title: 'Sync paused.',
      text: 'Something needs a look before syncing again. Nothing is resent automatically.',
      actions: [{ label: 'Sync now', action: 'sync' }],
      details: p.message,
      problem: p,
    };
  }

  const uncertain = unconfirmed(state);
  if (uncertain.length && !state.busy)
    return {
      tone: 'warn',
      icon: 'info',
      title: `${plural(uncertain.length, 'change')} sent to GitHub got no answer.`,
      text: 'GitHub does not show it yet, so it probably did not arrive. Check GitHub, then send it again if it is missing.',
      actions: [
        { label: 'Check on GitHub', action: 'open-github' },
        { label: 'Send again', action: 'send', primary: true },
      ],
    };

  if (state.busy === 'syncing' && !state.last)
    return {
      tone: 'info',
      icon: 'info',
      title: 'First import running.',
      text: 'You can look around; moving cards is available once it finishes.',
      actions: [],
    };

  return undefined;
}

/** The connection bar's status line. */
export function connectionLine(state: Ready): string {
  const held = state.last?.result.held.length ?? 0;
  const waiting = held
    ? ` · ${plural(held, 'change')} waiting to send`
    : state.touched?.length
      ? ` · ${plural(state.touched.length, 'change')} saving`
      : '';
  if (state.busy === 'syncing' && !state.last) return 'Importing…';
  if (state.busy === 'syncing') return `Checking GitHub for changes${waiting}`;
  if (state.busy === 'sending') return `Sending to GitHub${waiting}`;
  if (state.busy === 'resolving') return 'Settling the conflict…';
  const time = state.last?.at
    ? new Date(state.last.at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  if (state.problem?.kind === 'conflict' || state.problem?.kind === 'paused')
    return `Paused${time ? ` at ${time}` : ''}${waiting}`;
  if (!state.last?.at) return `Not synced yet${waiting}`;

  return `Last sync ${time}${waiting}`;
}

export type Marker = 'waiting' | 'sending' | 'conflict';

/** Per-row sync marker: a hollow dot, a spinning arc, or a warning. */
export function markers(state: Ready): Map<string, Marker> {
  const out = new Map<string, Marker>();
  const held = state.last?.result.held ?? [];
  const rows = state.last?.result.rows ?? [];
  const commentOwner = new Map<string, string>();
  for (const row of rows)
    for (const c of row.comments) commentOwner.set(c.subject, row.subject);

  for (const h of held) {
    const subject =
      h.local && commentOwner.has(h.local)
        ? commentOwner.get(h.local)!
        : h.local;
    if (subject)
      out.set(subject, state.busy === 'sending' ? 'sending' : 'waiting');
  }

  for (const subject of state.touched ?? [])
    out.set(subject, state.busy === 'sending' ? 'sending' : 'waiting');
  const p = state.problem;

  if (p?.kind === 'conflict' && p.local) {
    out.set(commentOwner.get(p.local) ?? p.local, 'conflict');
  }

  return out;
}

/** Comments whose GitHub write is held (shown "Waiting to send"). */
export function pendingComments(state: Ready): Set<string> {
  const out = new Set<string>();
  for (const h of state.last?.result.held ?? [])
    if (h.entity !== 'issue' && h.local) out.add(h.local);

  return out;
}

export const MARKER_TEXT: Record<Marker, string> = {
  waiting: 'Waiting to send',
  sending: 'Sending',
  conflict: 'Changed on both sides',
};

export interface Filter {
  search: string;
  label?: string;
}

/** Client-side search over title, number (`42` or `#42`) and label names. */
export function matches(row: IssueRow, { search, label }: Filter): boolean {
  if (label && !row.labels.some(l => l.name === label)) return false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [
    row.title.toLowerCase(),
    ...row.labels.map(l => l.name.toLowerCase()),
  ];

  return words.every(word => {
    const n = word.replace(/^#/, '');
    if (/^\d+$/.test(n) && row.number !== undefined && String(row.number) === n)
      return true;

    return hay.some(text => text.includes(word));
  });
}

export const filtering = (f: Filter) => !!(f.search.trim() || f.label);

/** Every label name in use, sorted, for the Label menu. */
export function labelNames(rows: IssueRow[]): string[] {
  return [...new Set(rows.flatMap(r => r.labels.map(l => l.name)))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export interface Column {
  status: Status;
  total: number;
  rows: IssueRow[];
  /** How many Done issues "Show N more" would add. */
  hidden: number;
}

const byNumber = (a: IssueRow, b: IssueRow) =>
  (a.number ?? -1) - (b.number ?? -1);
const byRecent = (a: IssueRow, b: IssueRow) =>
  (b.updatedAt ?? '￿').localeCompare(a.updatedAt ?? '￿');

/**
 * Three columns. Todo and Doing in issue order (new, unsent ones first);
 * Done by most recent update, collapsed to `DONE_LIMIT` unless `allDone`.
 */
export function columns(
  rows: IssueRow[],
  filter: Filter,
  allDone = false,
): Column[] {
  const shown = rows.filter(r => matches(r, filter));

  return STATUSES.map(status => {
    const all = shown
      .filter(r => r.status === status)
      .sort(status === 'Done' ? byRecent : byNumber);
    const cut = status === 'Done' && !allDone ? DONE_LIMIT : Infinity;

    return {
      status,
      total: all.length,
      rows: all.slice(0, cut),
      hidden: Math.max(0, all.length - cut),
    };
  });
}

/** "26 open · 315 done", or "3 of 341 shown" while filtering. */
export function countText(rows: IssueRow[], filter: Filter): string {
  if (filtering(filter)) {
    const n = rows.filter(r => matches(r, filter)).length;

    return `${n} of ${rows.length} shown`;
  }

  const done = rows.filter(r => r.status === 'Done').length;

  return `${rows.length - done} open · ${done} done`;
}

export type Layout = 'board' | 'list';
export type DetailMode = 'docked' | 'drawer' | 'sheet';

/** Board at ≥ 720 px, list below; an explicit choice wins at every width. */
export function layoutFor(size: Size, chosen?: Layout): Layout {
  return chosen ?? (size === 's' || size === 'm' ? 'list' : 'board');
}

export function detailModeFor(size: Size): DetailMode {
  return size === 'xl' ? 'docked' : size === 's' ? 'sheet' : 'drawer';
}

/** Moving a card is off until the first pass has a checkpoint to reconcile against. */
export function canMove(state: ViewState): boolean {
  return state.kind === 'ready' && !!state.last && state.last.at > 0;
}

export const STATUS_KEYS: Record<string, Status> = {
  '1': 'Todo',
  '2': 'Doing',
  '3': 'Done',
};

/** The `?` overlay, from DESIGN.md → Interactions. */
export const SHORTCUTS: [string, string][] = [
  ['J / K or arrows', 'Move focus between issues'],
  ['Enter', 'Open the focused issue'],
  ['Esc', 'Close the panel'],
  ['1 / 2 / 3', 'Set status to Todo / Doing / Done'],
  ['C', 'Comment on the open issue'],
  ['N', 'New issue'],
  ['B', 'Switch between board and list'],
  ['/', 'Search'],
  ['G then S', 'Sync now'],
  ['?', 'Show this list'],
];

/** True when a keystroke belongs to a text field, not to the shortcuts. */
export function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;

  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}
