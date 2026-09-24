// @wc-ignore-file
/**
 * Every property and class the app reads or writes, in one place.
 *
 * Atomic's own properties are fixed URLs. The app's own fields are not: a
 * host's `/app-write` rejects a property URL that does not resolve to a
 * Property (`value_for` in atomic-server's `store_host.rs`), so the app
 * creates one Property per field under its row class's ontology, inside its
 * own subtree, and finds them again by shortname (`schema.ts`). The same
 * pattern as the Pets and Notion drive apps.
 */

const A = 'https://atomicdata.dev';

export const atomic = {
  name: `${A}/properties/name`,
  description: `${A}/properties/description`,
  shortname: `${A}/properties/shortname`,
  datatype: `${A}/properties/datatype`,
  parent: `${A}/properties/parent`,
  isA: `${A}/properties/isA`,
  properties: `${A}/properties/properties`,
  recommends: `${A}/properties/recommends`,
  propertyClass: `${A}/classes/Property`,
} as const;

export const NAME = atomic.name;

export const datatypes = {
  string: `${A}/datatypes/string`,
  timestamp: `${A}/datatypes/timestamp`,
  boolean: `${A}/datatypes/boolean`,
  integer: `${A}/datatypes/integer`,
} as const;

export interface Field {
  shortname: string;
  name: string;
  datatype: string;
  description: string;
}

const field = (
  shortname: string,
  name: string,
  datatype: string,
  description: string,
): Field => ({ shortname, name, datatype, description });

/** Columns of an imported time entry, besides Atomic's own `name`. */
export const ROW_FIELDS = {
  entryId: field(
    'clockify-entry-id',
    'Clockify entry id',
    datatypes.string,
    'The id of the Clockify time entry this row was imported from.',
  ),
  start: field(
    'start',
    'Start',
    datatypes.timestamp,
    'When the time entry started.',
  ),
  end: field('end', 'End', datatypes.timestamp, 'When the time entry ended.'),
  billable: field(
    'billable',
    'Billable',
    datatypes.boolean,
    'Whether Clockify marks the entry billable.',
  ),
  projectId: field(
    'clockify-project-id',
    'Clockify project id',
    datatypes.string,
    'The id of the Clockify project the entry belongs to.',
  ),
  projectName: field(
    'project',
    'Project',
    datatypes.string,
    'The name of the Clockify project the entry belongs to.',
  ),
  memberId: field(
    'clockify-user-id',
    'Clockify user id',
    datatypes.string,
    'The id of the Clockify user who tracked the entry.',
  ),
  memberName: field(
    'member',
    'Member',
    datatypes.string,
    'The name of the Clockify user who tracked the entry.',
  ),
} as const;

/**
 * What the App resource stores about its Clockify setup: public ids and the
 * look-back window. There is deliberately no field for a connection id, code,
 * token or capability. The host page holds the connection and hands the app
 * only `{ platform, connectionId }` through `store.proxy.connections()` (#21).
 */
export const SETTING_FIELDS = {
  workspaceId: field(
    'clockify-workspace',
    'Clockify workspace id',
    datatypes.string,
    'The Clockify workspace this app imports from.',
  ),
  userId: field(
    'clockify-account',
    'Clockify account id',
    datatypes.string,
    'The Clockify user whose time entries this app imports.',
  ),
  lookbackDays: field(
    'clockify-lookback-days',
    'Look-back (days)',
    datatypes.integer,
    'How many days back each import reads: 7 or 30.',
  ),
} as const;

export type RowKey = keyof typeof ROW_FIELDS;
export type SettingKey = keyof typeof SETTING_FIELDS;
