// @wc-ignore-file
/**
 * Renders the design's frames (`design/mockups.html`, #89) from the real
 * views with the mockup's sample data and a stub controller: for the DOM
 * tests, the screenshots and the accessibility check. Test-only; not
 * imported by `main.ts`, so not bundled.
 */
import type { SetupOptions } from '../clockifyApi.js';
import type { Controller, SyncOutcome, ViewState } from '../controller.js';
import { SAMPLE_NOW, sampleTimesheet } from '../model/sample.js';
import type { Timesheet } from '../model/types.js';
import type { Problem } from '../problem.js';
import type { SyncResult } from '../sync.js';
import { mountShell, type Shell } from './shell.js';
import { installStyles } from './theme.js';

const CONNECTION = { platform: 'clockify', connectionId: 'c1' };
const SETTINGS = {
  workspaceId: 'ws-veldkamp',
  userId: 'u-mira',
  lookbackDays: 30 as const,
};
const OPTIONS: SetupOptions = {
  user: {
    id: 'u-mira',
    name: 'Mira Janssen',
    email: 'mira@studio-veldkamp.example',
    activeWorkspace: 'ws-veldkamp',
  },
  workspaces: [
    { id: 'ws-veldkamp', name: 'Studio Veldkamp' },
    { id: 'ws-kestrel', name: 'Kestrel BV' },
  ],
};

const ok = (minutesAgo: number, warnings: string[] = []): SyncOutcome => ({
  ok: true,
  at: SAMPLE_NOW - minutesAgo * 60_000,
  result: {
    created: 0,
    updated: 0,
    unchanged: 61,
    removed: 0,
    warnings,
    log: {
      incrementals: 0,
      snapshotWritten: false,
      candidates: 0,
      unknownMs: 0,
    },
    account: {},
  } as unknown as SyncResult,
});
const failed = (problem: Problem, minutesAgo = 0): SyncOutcome => ({
  ok: false,
  error: problem.detail,
  at: SAMPLE_NOW - minutesAgo * 60_000,
  problem,
});
const ready = (last?: SyncOutcome, lookbackDays: 7 | 30 = 30): ViewState => ({
  kind: 'ready',
  connection: CONNECTION,
  settings: { ...SETTINGS, lookbackDays },
  ...(last ? { last } : {}),
});

export const FRAMES = {
  a: { width: 1080, title: 'A Week' },
  b: { width: 760, title: 'B Entries (highlighted from a Week cell)' },
  c: { width: 760, title: 'C Projects' },
  d: { width: 1080, title: 'D Entry detail' },
  e: { width: 360, title: 'E Narrow week strip' },
  e2: { width: 360, title: 'E Detail as a sheet' },
  f: { width: 560, title: 'F Not connected' },
  g1: { width: 560, title: 'G1 Waiting on the consent bar' },
  g2: { width: 560, title: 'G2 Workspace and window' },
  h: { width: 760, title: 'H First import' },
  i: { width: 560, title: 'I Empty window' },
  j: { width: 760, title: 'J Reconnect needed' },
  j2: { width: 560, title: 'J Rate limited' },
  j3: { width: 560, title: 'J Network' },
  j4: { width: 560, title: 'J Forbidden' },
  j5: { width: 560, title: 'J Warnings' },
  j6: { width: 560, title: 'J Too many' },
  k: { width: 560, title: 'K No relay' },
  l: { width: 560, title: 'L Week outside the window' },
  m: { width: 560, title: 'M Settings' },
  o: { width: 1080, title: 'O Dark' },
} as const;

export type FrameId = keyof typeof FRAMES;

/** Host dark-theme values for the `--t-*` variables (frame O). */
export const DARK_THEME = `:root {
  --t-color-bg-body: #000000; --t-color-bg: #000000; --t-color-bg-1: #1a1a1a;
  --t-color-bg-2: #4d4d4d; --t-color-text: #ffffff; --t-color-text-light: #999999;
  --t-color-main: #3d6ff0; --t-color-main-selected-bg: #04091a; color-scheme: dark;
}`;

interface Stub {
  controller: Controller;
  set(state: ViewState): void;
}

function stub(
  initial: ViewState,
  sheet: Timesheet | undefined,
  render: () => void,
): Stub {
  let state = initial;

  const set = (next: ViewState) => {
    state = next;
    render();

    return state;
  };

  const back = (): ViewState => set(ready(ok(4)));
  const controller: Controller = {
    state: () => state,
    load: async () => ({}),
    appChanged: async () => ({}),
    connect: async () => set({ kind: 'connecting' }),
    openSettings: async () =>
      set({
        kind: 'setup',
        connection: CONNECTION,
        draft: SETTINGS,
        options: OPTIONS,
      }),
    saveSettings: async () => back(),
    sync: async () =>
      set({ kind: 'syncing', connection: CONNECTION, settings: SETTINGS }),
    cancelSettings: back,
    setLookback: async () => back(),
    reconnect: async () => set({ kind: 'connecting' }),
    canDisconnect: () => true,
    disconnect: async () => set({ kind: 'not-connected' }),
    names: () => ({
      userName: 'Mira Janssen',
      workspaceName: 'Studio Veldkamp',
    }),
    sheet: () => sheet,
  };

  return { controller, set: next => void set(next) };
}

const click = (root: HTMLElement, selector: string, text?: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)]
    .find(node => !text || node.textContent?.includes(text))
    ?.click();

/**
 * Mounts frame `id` into `root` and drives it to the drawn state. Styles are
 * installed into `root`; the caller sizes it to `FRAMES[id].width`.
 */
export function renderFrame(root: HTMLElement, id: FrameId): Shell {
  installStyles(root);

  if (id === 'o') {
    const dark = root.ownerDocument.createElement('style');
    dark.textContent = DARK_THEME;
    root.append(dark);
  }

  const sheet = sampleTimesheet();
  const empty = sampleTimesheet({ entries: [], running: 0 });
  const seven = sampleTimesheet({
    entries: [],
    running: 0,
    window: { from: SAMPLE_NOW - 7 * 86_400_000, to: SAMPLE_NOW },
  });
  const offline = sampleTimesheet({ window: undefined, running: 0 });
  const problem = (
    kind: Problem['kind'],
    detail: string,
    retry?: number,
    minutesAgo = 120,
  ) =>
    ready(
      failed(
        { kind, detail, ...(retry ? { retryAfterSeconds: retry } : {}) },
        minutesAgo,
      ),
    );

  const table: Record<FrameId, [ViewState, Timesheet | undefined]> = {
    a: [ready(ok(4)), sheet],
    b: [ready(ok(4)), sheet],
    c: [ready(ok(4)), sheet],
    d: [ready(ok(4)), sheet],
    e: [ready(ok(4)), sheet],
    e2: [ready(ok(4)), sheet],
    f: [{ kind: 'not-connected' }, undefined],
    g1: [{ kind: 'connecting' }, undefined],
    g2: [
      { kind: 'setup', connection: CONNECTION, draft: {}, options: OPTIONS },
      undefined,
    ],
    h: [
      {
        kind: 'syncing',
        connection: CONNECTION,
        settings: SETTINGS,
        progress: { phase: 'save', done: 24, total: 61 },
      },
      empty,
    ],
    i: [ready(ok(0), 7), seven],
    j: [
      problem(
        'reauth',
        'HTTP 401 on GET /api/v1/workspaces/…/user/…/time-entries "Full authentication is required to access this resource"',
      ),
      sheet,
    ],
    j2: [problem('rate-limited', 'HTTP 429 on GET /api/v1/…', 30, 0), sheet],
    j3: [
      problem('network', 'TypeError: Failed to fetch (host relay → proxy)'),
      sheet,
    ],
    j4: [
      problem('forbidden', 'HTTP 403 on GET /api/v1/workspaces/…/time-entries'),
      sheet,
    ],
    j5: [
      ready(
        ok(4, [
          'Clockify request /api/v1/workspaces/…/projects failed with 403',
        ]),
      ),
      sheet,
    ],
    j6: [
      problem('too-many', 'Clockify /api/v1/… returned more than 200 pages'),
      sheet,
    ],
    k: [{ kind: 'no-proxy' }, offline],
    l: [ready(ok(4)), sheet],
    m: [ready(ok(4)), sheet],
    o: [ready(ok(4)), sheet],
  };

  let shell: Shell | undefined;
  const [state, data] = table[id];
  const { controller } = stub(state, data, () => shell?.render());
  shell = mountShell(root, controller, {
    now: () => SAMPLE_NOW,
    width: FRAMES[id].width,
  });
  shell.render();

  switch (id) {
    case 'b':
      click(root, '[data-k="cell:p-kestrel:2026-09-24"]');
      break;
    case 'c':
      click(root, '[data-k="view:projects"]');
      break;
    case 'd':
      click(root, '[data-k="view:entries"]');
      click(root, '.entry', 'Homepage hero, responsive pass');
      break;
    case 'e2':
      click(root, '.entry', 'Homepage hero, responsive pass');
      break;
    case 'k':
      click(root, '[data-k="view:entries"]');
      break;
    case 'l':
      for (let i = 0; i < 4; i++) click(root, '[data-k="prev"]');
      break;
    case 'm':
      click(root, '[data-k="settings"]');
      break;
  }

  return shell;
}
