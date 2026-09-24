// @wc-ignore-file
/**
 * The shared mock proxy's Clockify fixture, reached the way the host relay
 * reaches the real proxy: `{ platform, connectionId, path, query }` in,
 * `{ status, body }` out. Test-only; not bundled.
 */
import {
  clockifyEntries,
  clockifyFixture,
} from '../fixtures/clockify/scenario.mjs';
import type { HostProxyRequest } from './store.js';

export function fixtureProxy(now: number, options?: { withNames?: boolean }) {
  const fixture = clockifyFixture(options);
  // Pin the fixture's relative timestamps so the window is deterministic.
  fixture.state.entries = clockifyEntries(now);
  const seen: HostProxyRequest[] = [];

  const request = async (req: HostProxyRequest) => {
    seen.push(req);
    const url = new URL(
      `/proxy/${req.platform}${req.path}`,
      'http://proxy.test',
    );
    for (const [k, v] of Object.entries(req.query ?? {}))
      url.searchParams.set(k, v);

    return fixture.request(req.method ?? 'GET', url);
  };

  return { fixture, seen, request };
}
