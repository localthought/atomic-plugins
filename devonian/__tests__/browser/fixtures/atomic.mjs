// Browser smoke driver for `devonian/atomic`; see root.mjs.
import {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
  Datatype,
  IS_A,
} from 'devonian/atomic';

const NAME = 'https://example.com/p/name';
const THING = 'https://example.com/c/Thing';

globalThis.__result = (async () => {
  const store = new AtomicStore(
    new AtomicSchema().property(NAME, Datatype.STRING),
  );
  const identities = new AtomicIdentityMap(store, 'https://example.com/bridge');
  const records = new Map();
  const lens = new AtomicLens({
    store,
    identities,
    scope: 'https://example.com/accounts/acme',
    entity: 'thing',
    connector: {
      id: (r) => r.id,
      get: async (id) => structuredClone(records.get(id)),
      create: async (r) => {
        const created = { ...r, id: `server-${records.size}` };
        records.set(created.id, created);
        return created;
      },
      update: async (id, r) => {
        records.set(id, structuredClone(r));
      },
      delete: async (id) => {
        records.delete(id);
      },
    },
    read: (input) => ({ set: { [IS_A]: [THING], [NAME]: input.name } }),
    write: (resource, previous) => ({
      ...previous,
      id: previous?.id ?? '',
      name: resource[NAME],
    }),
  });
  records.set('t1', { id: 't1', name: 'Anvil' });
  const subject = await lens.ingest({ id: 't1', name: 'Anvil' });
  store.patch(subject, { set: { [NAME]: 'Rocket' } });
  const published = await lens.publish(subject);
  const scope = { scope: 'https://example.com/accounts/acme', entity: 'thing' };
  const unbound = identities.unbind(scope, subject);
  return {
    published,
    name: records.get('t1').name,
    count: store.all(THING).length,
    unbound,
    bound: identities.externalId(scope, subject) ?? null,
  };
})();
