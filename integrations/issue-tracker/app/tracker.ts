// @wc-ignore-file
/**
 * The app's own data in the user's drive, all inside the app's subtree (the
 * only place a drive app may write):
 *
 * - Properties under the ontology that holds the table's row class, created
 *   once and found again by shortname, as pets/app does: Status (a select
 *   with Todo / Doing / Done tags, parented to the property the way the
 *   data-browser's own select columns are), GitHub issue number, GitHub
 *   source, and the two properties of the sync resource. The issue body uses
 *   Atomic's own `description`, so rows read as ordinary described rows.
 * - One sync resource under the app (found by its `localId`): the bound
 *   repository and the sync state as JSON text. Its class is created under
 *   the same ontology.
 * - One folder under the app for the GitHub comments (Messages `about` a
 *   row), also found by `localId`.
 *
 * Every lookup goes through a resource the host reads back (`getResource`)
 * or a `localId`, which AtomicServer keeps unique per parent, so running
 * this twice does not create anything twice.
 */
import type { JSONValue, PluginResource, PluginStore } from './store.js';

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const PROPERTIES = `${A}/properties/properties`;
export const CLASSES = `${A}/properties/classes`;
export const CLASSTYPE = `${A}/properties/classtype`;
export const ALLOWS_ONLY = `${A}/properties/allowsOnly`;
export const LOCAL_ID = `${A}/properties/localId`;
export const COLOR = `${A}/properties/color`;
export const ABOUT = `${A}/properties/about`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
export const SELECT_PROPERTY = `${A}/classes/SelectProperty`;
export const CLASS_CLASS = `${A}/classes/Class`;
export const TAG = `${A}/classes/Tag`;
export const FOLDER = `${A}/classes/Folder`;
export const MESSAGE = `${A}/classes/Message`;

const datatypes = {
  string: `${A}/datatypes/string`,
  integer: `${A}/datatypes/integer`,
  resourceArray: `${A}/datatypes/resourceArray`,
};

export const STATUSES = ['Todo', 'Doing', 'Done'] as const;
export type Status = (typeof STATUSES)[number];
const TAG_COLOURS: Record<Status, string> = {
  Todo: '#8a8a8a',
  Doing: '#2f6fd6',
  Done: '#2f8f5b',
};

export const SYNC_LOCAL_ID = 'github-issues:sync';
export const COMMENTS_LOCAL_ID = 'github-issues:comments';

/** What `AtomicPort` consumes, plus the app's own subjects. */
export interface Tracker {
  app: string;
  table: string;
  rowClass: string;
  properties: {
    status: string;
    number: string;
    provenance: string;
    repository: string;
    syncState: string;
  };
  tags: Record<Status, string>;
  commentsFolder: string;
}

interface PropertySpec {
  key: keyof Tracker['properties'];
  shortname: string;
  name: string;
  datatype: string;
  description: string;
  select?: boolean;
}

const PROPERTY_SPECS: PropertySpec[] = [
  {
    key: 'status',
    shortname: 'issue-status',
    name: 'Status',
    datatype: datatypes.resourceArray,
    description:
      'Todo, Doing or Done. Done is a closed GitHub issue; Doing is an open one with the atomic:doing label.',
    select: true,
  },
  {
    key: 'number',
    shortname: 'github-issue-number',
    name: 'GitHub issue number',
    datatype: datatypes.integer,
    description: 'The issue number in the bound GitHub repository.',
  },
  {
    key: 'provenance',
    shortname: 'github-source',
    name: 'GitHub source',
    datatype: datatypes.string,
    description:
      'JSON text written by the GitHub issues app: the GitHub author, URL and timestamps. Not an Atomic authorship claim.',
  },
  {
    key: 'repository',
    shortname: 'github-repository',
    name: 'GitHub repository',
    datatype: datatypes.string,
    description: 'The owner/name of the repository this app syncs with.',
  },
  {
    key: 'syncState',
    shortname: 'github-sync-state',
    name: 'GitHub sync state',
    datatype: datatypes.string,
    description:
      'JSON text: the sync checkpoint and write journal of the GitHub issues app. Edit it and sync can no longer tell what was already sent.',
  },
];

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** The one resource under `parent` with this `localId`, if any. */
export async function findByLocalId(
  store: PluginStore,
  parent: string,
  localId: string,
): Promise<PluginResource | undefined> {
  for (const subject of await store.query({
    property: LOCAL_ID,
    value: localId,
  })) {
    const resource = await store.getResource(subject);
    if (resource.get(PARENT) === parent) return resource;
  }

  return undefined;
}

async function ensureProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Record<PropertySpec['key'], string>> {
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = new Map<string, string>();

  for (const subject of listed) {
    const property = await store.getResource(subject);
    const shortname = property.get(SHORTNAME);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  const created: string[] = [];
  const out = {} as Record<PropertySpec['key'], string>;

  for (const spec of PROPERTY_SPECS) {
    let subject = byShortname.get(spec.shortname);

    if (!subject) {
      const property = await store.newResource({
        parent: ontology.subject,
        isA: spec.select ? [PROPERTY_CLASS, SELECT_PROPERTY] : [PROPERTY_CLASS],
        propVals: {
          [SHORTNAME]: spec.shortname,
          [NAME]: spec.name,
          [DESCRIPTION]: spec.description,
          [DATATYPE]: spec.datatype,
          ...(spec.select ? { [CLASSTYPE]: TAG, [ALLOWS_ONLY]: [] } : {}),
        },
      });
      subject = property.subject;
      created.push(subject);
    }

    out[spec.key] = subject;
  }

  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  return out;
}

async function ensureTags(
  store: PluginStore,
  statusProperty: string,
): Promise<Record<Status, string>> {
  const property = await store.getResource(statusProperty);
  const allowed = asList(property.get(ALLOWS_ONLY));
  const byShortname = new Map<string, string>();

  for (const subject of allowed) {
    const tag = await store.getResource(subject);
    const shortname = tag.get(SHORTNAME);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  const tags = {} as Record<Status, string>;
  const created: string[] = [];

  for (const status of STATUSES) {
    const shortname = status.toLowerCase();
    let subject = byShortname.get(shortname);

    if (!subject) {
      const tag = await store.newResource({
        parent: statusProperty,
        isA: [TAG],
        propVals: { [SHORTNAME]: shortname, [COLOR]: TAG_COLOURS[status] },
      });
      subject = tag.subject;
      created.push(subject);
    }

    tags[status] = subject;
  }

  if (created.length > 0)
    await property.set(ALLOWS_ONLY, [...allowed, ...created]).save();

  return tags;
}

async function ensureClass(
  store: PluginStore,
  ontology: PluginResource,
  recommends: string[],
): Promise<string> {
  const classes = asList(ontology.get(CLASSES));

  for (const subject of classes) {
    const klass = await store.getResource(subject);
    if (klass.get(SHORTNAME) === 'github-issue-tracker-sync') return subject;
  }

  const klass = await store.newResource({
    parent: ontology.subject,
    isA: [CLASS_CLASS],
    propVals: {
      [SHORTNAME]: 'github-issue-tracker-sync',
      [NAME]: 'GitHub issue tracker sync',
      [DESCRIPTION]:
        'Where the GitHub issues app keeps its bound repository and sync state.',
      [RECOMMENDS]: recommends,
    },
  });
  await ontology.set(CLASSES, [...classes, klass.subject]).save();

  return klass.subject;
}

/** The bound repository, or undefined before one was chosen. */
export async function boundRepository(
  store: PluginStore,
): Promise<string | undefined> {
  const app = await store.getApp();
  const sync = await findByLocalId(store, app, SYNC_LOCAL_ID);
  if (!sync) return undefined;
  const data = await store.getData();
  if (!data?.rowClass) return undefined;
  const ontology = (await store.getResource(data.rowClass)).get(PARENT);
  if (typeof ontology !== 'string') return undefined;

  for (const subject of asList(
    (await store.getResource(ontology)).get(PROPERTIES),
  )) {
    const property = await store.getResource(subject);
    if (property.get(SHORTNAME) !== 'github-repository') continue;
    const value = sync.get(subject);

    return typeof value === 'string' && value ? value : undefined;
  }

  return undefined;
}

/**
 * Creates (or finds) everything above and binds `repository` on first use.
 * A later call with another repository throws: one app, one repository.
 */
export async function provision(
  store: PluginStore,
  repository?: string,
): Promise<{ tracker: Tracker; sync: PluginResource; repository: string }> {
  const app = await store.getApp();
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to sync into.');
  const klass = await store.getResource(data.rowClass);
  const ontologySubject = klass.get(PARENT);
  if (typeof ontologySubject !== 'string')
    throw new Error('The row class has no parent ontology to add fields to.');
  const ontology = await store.getResource(ontologySubject);

  const properties = await ensureProperties(store, ontology);
  const tags = await ensureTags(store, properties.status);

  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [
    NAME,
    DESCRIPTION,
    properties.status,
    properties.number,
    properties.provenance,
  ];
  const merged = [
    ...recommends,
    ...wanted.filter(s => !recommends.includes(s)),
  ];
  if (merged.length !== recommends.length || klass.get(NAME) !== 'Issue')
    await klass.set(RECOMMENDS, merged).set(NAME, 'Issue').save();

  // The same `ontology` object: a fresh read could lag the save above, and
  // the host's `save` sends every property it holds, stale ones included.
  const syncClass = await ensureClass(store, ontology, [
    NAME,
    properties.repository,
    properties.syncState,
  ]);

  let comments = await findByLocalId(store, app, COMMENTS_LOCAL_ID);
  comments ??= await store.newResource({
    parent: app,
    isA: [FOLDER],
    propVals: {
      [NAME]: 'GitHub comments',
      [LOCAL_ID]: COMMENTS_LOCAL_ID,
      [DESCRIPTION]:
        'Comments on the GitHub issues in this app’s table, as Messages about each row.',
    },
  });

  let sync = await findByLocalId(store, app, SYNC_LOCAL_ID);
  const bound = sync?.get(properties.repository);

  if (typeof bound === 'string' && bound) {
    if (repository && repository !== bound)
      throw new Error(
        `This app is bound to ${bound}. Install another app for ${repository}.`,
      );
    repository = bound;
  }

  if (!repository) throw new Error('Choose a GitHub repository first.');

  if (!sync) {
    sync = await store.newResource({
      parent: app,
      isA: [syncClass],
      propVals: {
        [NAME]: `GitHub sync: ${repository}`,
        [LOCAL_ID]: SYNC_LOCAL_ID,
        [properties.repository]: repository,
      },
    });
  }

  const table = await store.getResource(data.table);
  const tableName = `${repository} issues`;
  if (table.get(NAME) !== tableName) await table.set(NAME, tableName).save();

  return {
    repository,
    sync,
    tracker: {
      app,
      table: data.table,
      rowClass: data.rowClass,
      properties,
      tags,
      commentsFolder: comments.subject,
    },
  };
}
