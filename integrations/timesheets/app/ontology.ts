// @wc-ignore-file
/**
 * Every property/class URL the app reads or writes, in one place.
 *
 * All of these except `name` are PROVISIONAL. The install flow (#20 Phase 4,
 * atomic-server side) has to create real Property resources, or map these
 * onto the Time Tracker template's own start/end columns so the Timer view
 * keeps working, and hand the app the real subjects. Not verified: whether
 * `POST /app-write` accepts a property URL that does not resolve.
 */

const base = 'https://atomicdata.dev/integrations/timesheets';

export const NAME = 'https://atomicdata.dev/properties/name';

/**
 * Connection reference and selection, stored as ordinary public properties
 * on the App resource. There is deliberately no property for a connection
 * code, token or capability: the rotating code never leaves the parent
 * page's BrowserIntegrations (see #21), and a capability (#40) is minted
 * per frame, never stored.
 */
export const config = {
  connectionId: `${base}/properties/connection-id`,
  workspaceId: `${base}/properties/workspace-id`,
  userId: `${base}/properties/user-id`,
  lookbackDays: `${base}/properties/lookback-days`,
} as const;

/** Fallback row class when the host's `getData()` names none. */
export const TIME_ENTRY_CLASS = `${base}/classes/TimeEntry`;

export const row = {
  entryId: `${base}/properties/entry-id`,
  start: `${base}/properties/start`,
  end: `${base}/properties/end`,
  billable: `${base}/properties/billable`,
  projectId: `${base}/properties/project-id`,
  projectName: `${base}/properties/project-name`,
  memberId: `${base}/properties/member-id`,
  memberName: `${base}/properties/member-name`,
} as const;
