// Browser smoke driver for `devonian/reflect` (its `browser` export
// condition); see root.mjs.
import {
  InMemoryIdMap,
  InMemoryKvStore,
  embedMarker,
  parseMarker,
} from 'devonian/reflect';

globalThis.__result = (async () => {
  const ids = new InMemoryIdMap();
  ids.link('issue', { system: 'a', id: '1' }, { system: 'b', id: '9' });
  const kv = new InMemoryKvStore();
  kv.set('k', 'v');
  const body = embedMarker('hello', { system: 'a', kind: 'issue', id: '1' });
  return {
    counterpart: ids.counterpart('issue', 'a', '1'),
    kv: kv.get('k'),
    origin: parseMarker(body),
  };
})();
