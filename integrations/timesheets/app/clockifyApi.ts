// @wc-ignore-file
import { isTimeZone } from './timeZone.js';
import { ProxyError, requestJson, type ProxyTransport } from './transport.js';

/**
 * Clockify's setup and naming endpoints as reached through the integration
 * proxy (time entries are read by `clockifyObserve.ts`)
 * (`/proxy/clockify` + these paths, the same paths
 * `integrations/timesheets/fixtures/clockify/scenario.mjs` serves). Paging follows the
 * pageNumber scheme that mock documents: 1-indexed `page`/`page-size`, a
 * plain JSON array, and a page shorter than `page-size` is the last one.
 */

export const PAGE_SIZE = 50;
/** Stop rather than loop forever if a provider ignores `page`. */
export const MAX_PAGES = 200;

export interface RawTimeEntry {
  id: string;
  userId?: string;
  description?: string | null;
  billable?: boolean;
  projectId?: string | null;
  type?: string;
  timeInterval: { start: string | null; end: string | null };
  [field: string]: unknown;
}

export interface RawNamed {
  id: string;
  name: string;
  [field: string]: unknown;
}

async function fetchAllPages<T>(
  transport: ProxyTransport,
  path: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const all: T[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await requestJson<T[]>(transport, path, {
      ...query,
      page: String(page),
      'page-size': String(PAGE_SIZE),
    });
    if (!Array.isArray(items))
      throw new Error(`Clockify ${path} did not return a list`);
    all.push(...items);
    if (items.length < PAGE_SIZE) return all;
  }

  throw new Error(`Clockify ${path} returned more than ${MAX_PAGES} pages`);
}

export interface ClockifyUser {
  id: string;
  name?: string;
  email?: string;
  activeWorkspace?: string;
  settings?: { timeZone?: string; weekStart?: string };
}

export interface ClockifyWorkspace extends RawNamed {
  settings?: { forceProjects?: boolean };
}

/** What a sync needs to know about the account besides its entries. */
export interface AccountContext {
  /** The profile time zone the list's bounds are read in, if known. */
  timeZone?: string;
  /**
   * The workspace setting (checked live): with it on, Clockify refuses a
   * create or update without `projectId`, so "worked, no project" cannot
   * be written back there.
   */
  forceProjects?: boolean;
  /** The profile's first day of the week (`MONDAY` …), for the views. */
  weekStart?: string;
  /** Display names for the views' header: the account and the workspace. */
  userName?: string;
  workspaceName?: string;
  warnings: string[];
}

/**
 * The user's time zone (`GET /user` → `settings.timeZone`) and the
 * workspace's `forceProjects` (`GET /workspaces`), read on every sync so a
 * changed profile takes effect. A 403/404 on either is a warning; the time
 * zone is then unknown and the sync narrows what it claims to have read.
 */
export async function fetchAccountContext(
  transport: ProxyTransport,
  workspaceId: string,
): Promise<AccountContext> {
  const context: AccountContext = { warnings: [] };

  const soft = (error: unknown) => {
    if (
      !(error instanceof ProxyError) ||
      (error.status !== 403 && error.status !== 404)
    )
      throw error;
    context.warnings.push(error.message);
  };

  try {
    const user = await requestJson<ClockifyUser>(transport, '/api/v1/user');
    const zone = user?.settings?.timeZone;
    if (typeof user?.settings?.weekStart === 'string')
      context.weekStart = user.settings.weekStart;
    const userName = user?.name ?? user?.email;
    if (typeof userName === 'string' && userName) context.userName = userName;
    if (isTimeZone(zone)) context.timeZone = zone;
    else
      context.warnings.push(
        'Clockify did not name a known time zone for this account; the window is read less precisely.',
      );
  } catch (error) {
    soft(error);
  }

  try {
    const workspaces = await requestJson<ClockifyWorkspace[]>(
      transport,
      '/api/v1/workspaces',
    );
    const workspace = Array.isArray(workspaces)
      ? workspaces.find(w => w?.id === workspaceId)
      : undefined;
    const force = workspace?.settings?.forceProjects;
    if (typeof workspace?.name === 'string' && workspace.name)
      context.workspaceName = workspace.name;
    if (typeof force === 'boolean') context.forceProjects = force;
  } catch (error) {
    soft(error);
  }

  return context;
}

export interface SetupOptions {
  user: ClockifyUser;
  workspaces: RawNamed[];
}

/**
 * What setup offers: the connected account (`/api/v1/user`; a Clockify API
 * key belongs to exactly one user) and the workspaces it can see
 * (`/api/v1/workspaces`, one unpaged list). Only ids are stored afterwards.
 */
export async function fetchSetupOptions(
  transport: ProxyTransport,
): Promise<SetupOptions> {
  const user = await requestJson<ClockifyUser>(transport, '/api/v1/user');
  if (!user || typeof user.id !== 'string' || !user.id)
    throw new Error('Clockify did not say which account is connected');
  const workspaces = await requestJson<RawNamed[]>(
    transport,
    '/api/v1/workspaces',
  );
  if (!Array.isArray(workspaces))
    throw new Error('Clockify /api/v1/workspaces did not return a list');

  return {
    user,
    workspaces: workspaces.filter(
      w => w && typeof w.id === 'string' && typeof w.name === 'string',
    ),
  };
}

/**
 * Projects or members, for naming references. A 403/404 here is not fatal —
 * the lens treats an unresolved id as a dangling reference, not an error —
 * so it comes back as a warning and an empty list.
 */
export async function fetchNamed(
  transport: ProxyTransport,
  workspaceId: string,
  collection: 'projects' | 'users',
): Promise<{ items: RawNamed[]; warning?: string }> {
  try {
    return {
      items: await fetchAllPages<RawNamed>(
        transport,
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/${collection}`,
      ),
    };
  } catch (error) {
    if (
      error instanceof ProxyError &&
      (error.status === 403 || error.status === 404)
    )
      return { items: [], warning: error.message };
    throw error;
  }
}
