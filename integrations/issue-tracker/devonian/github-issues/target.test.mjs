import { expect, it } from 'vitest';
import {
  atomicTarget,
  provisionTracker,
  trackerStateKey,
  trackerTableSpec,
} from './target.mjs';

const commentsFolder = 'https://atomicdata.dev/properties/commentsFolder';
const drive = 'https://atomic.example/drive';

function fakeStore({ localOnly = false, existingComments } = {}) {
  const resources = new Map();

  const make = (subject, props) => {
    const r = {
      subject,
      props,
      saves: 0,
      get: p => r.props[p],
      set: async (p, v) => {
        r.props[p] = v;
      },
      save: async () => {
        r.saves++;
        resources.set(subject, r);
      },
    };

    return r;
  };

  resources.set(
    drive,
    make(drive, existingComments ? { [commentsFolder]: existingComments } : {}),
  );
  const store = {
    isLocalOnlyDrive: d => localOnly && d === drive,
    hasCompletedDriveSyncFor: d => d === drive,
    getSaveState: () => ({ kind: 'idle' }),
    getResource: async s => resources.get(s),
    newResource: async ({ parent, isA, propVals }) =>
      make(`${drive}/r${resources.size}`, {
        'https://atomicdata.dev/properties/parent': parent,
        'https://atomicdata.dev/properties/isA': isA,
        ...propVals,
      }),
  };

  return { store, resources };
}

const buildTable = async spec => {
  expect(spec).toBe(trackerTableSpec);

  return {
    tableSubject: `${drive}/table`,
    classSubject: `${drive}/Issue`,
    columns: {
      Description: `${drive}/description`,
      Status: `${drive}/status`,
      'GitHub issue number': `${drive}/number`,
    },
    tags: {
      Status: {
        Todo: `${drive}/todo`,
        Doing: `${drive}/doing`,
        Done: `${drive}/done`,
      },
    },
  };
};

it('classifies local-only and synced drives, failing closed', () => {
  expect(atomicTarget(fakeStore({ localOnly: true }).store, drive)).toEqual({
    drive,
    kind: 'local-only',
    ready: true,
  });
  expect(atomicTarget(fakeStore().store, drive)).toEqual({
    drive,
    kind: 'synced',
    ready: true,
  });
  expect(
    atomicTarget(fakeStore().store, 'https://atomic.example/other').ready,
  ).toBe(false);
  expect(atomicTarget({}, drive)).toEqual({
    drive,
    kind: 'synced',
    ready: false,
  });
  expect(() => atomicTarget({}, '')).toThrow('An Atomic drive is required');
});

it('provisions a tracker inside an existing real drive and reuses its Comments folder', async () => {
  const existing = 'https://atomic.example/drive/my-comments';
  const { store, resources } = fakeStore({ existingComments: existing });
  const config = await provisionTracker(store, {
    drive,
    repository: 'owner/repo',
    buildTable,
  });
  expect(config.commentsFolder).toBe(existing);
  expect(resources.get(drive).get(commentsFolder)).toBe(existing);
  expect(resources.get(drive).saves).toBe(0);
  expect(config.connection).toMatchObject({
    repository: 'owner/repo',
    drive,
    table: `${drive}/table`,
    rowClass: `${drive}/Issue`,
    body: `${drive}/description`,
    status: `${drive}/status`,
    number: `${drive}/number`,
  });
  const provenance = resources.get(config.provenance);
  expect(provenance.get('https://atomicdata.dev/properties/parent')).toBe(
    drive,
  );
  expect(provenance.get('https://atomicdata.dev/properties/datatype')).toBe(
    'https://atomicdata.dev/datatypes/json',
  );
});

it('creates a Comments folder only when the drive has none', async () => {
  const { store, resources } = fakeStore({ localOnly: true });
  const config = await provisionTracker(store, {
    drive,
    repository: 'owner/repo',
    buildTable,
  });
  const folder = resources.get(config.commentsFolder);
  expect(folder.get('https://atomicdata.dev/properties/isA')).toEqual([
    'https://atomicdata.dev/classes/Folder',
  ]);
  expect(resources.get(drive).get(commentsFolder)).toBe(config.commentsFolder);
});

it('stops provisioning when AtomicServer rejects a write', async () => {
  const { store } = fakeStore();
  store.getSaveState = () => ({ kind: 'error', error: 'no write right' });
  await expect(
    provisionTracker(store, { drive, repository: 'owner/repo', buildTable }),
  ).rejects.toThrow('Atomic write rejected');
});

it('rejects an incomplete host table', async () => {
  const { store } = fakeStore();
  await expect(
    provisionTracker(store, {
      drive,
      repository: 'owner/repo',
      buildTable: async () => ({ tableSubject: 't', columns: {} }),
    }),
  ).rejects.toThrow('Description column');
});

it('keys tracker state by drive as well as agent, repository and mode', () => {
  const base = { agent: 'did:ad:agent:a', repository: 'o/r', mode: 'live' };
  const a = trackerStateKey({ ...base, drive });
  const b = trackerStateKey({ ...base, drive: 'https://atomic.example/other' });
  expect(a).not.toBe(b);
  expect(() => trackerStateKey({ ...base })).toThrow('needs drive');
});
