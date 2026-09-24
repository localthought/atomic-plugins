// Browser smoke driver for the package root (`devonian`). Bundled by
// ../bundle.test.ts with esbuild --platform=browser and run in a node:vm
// context without Node globals. Plain JS so tsc never tries to resolve the
// bare `devonian` specifier against build/.
import {
  AtomicSchema,
  AtomicStore,
  Datatype,
  DevonianClient,
  DevonianEventEmitter,
  DevonianLens,
  DevonianTable,
  reconcileRecord,
} from 'devonian';

class MemoryClient extends DevonianClient {
  added = [];
  async add(obj) {
    this.added.push(obj);
    return { ...JSON.parse(JSON.stringify(obj)), id: this.added.length - 1 };
  }
}

globalThis.__result = (async () => {
  const left = new MemoryClient();
  const right = new MemoryClient();
  const table = (client, platform) =>
    new DevonianTable({
      client,
      platform,
      idFieldName: 'id',
      replicaId: 'browser',
    });
  new DevonianLens(
    table(left, 'left'),
    table(right, 'right'),
    async (l) => ({ title: l.name, foreignIds: l.foreignIds }),
    async (r) => ({ name: r.title, foreignIds: r.foreignIds }),
  );
  left.emit('add-from-client', { id: 7, name: 'Anvil', foreignIds: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const emitter = new DevonianEventEmitter();
  const seen = [];
  emitter.once('x', (v) => seen.push(`once:${v}`));
  emitter.on('x', (v) => seen.push(`on:${v}`));
  emitter.emit('x', 1);
  emitter.emit('x', 2);

  const store = new AtomicStore(
    new AtomicSchema().property('https://example.com/p/name', Datatype.STRING),
  );
  store.put({
    '@id': 'https://example.com/r/1',
    'https://example.com/p/name': 'Anvil',
  });

  return {
    rightAdded: right.added.map((r) => r.title),
    seen,
    resources: JSON.parse(store.toJSONAD()).length,
    reconcileRecord: typeof reconcileRecord,
  };
})();
