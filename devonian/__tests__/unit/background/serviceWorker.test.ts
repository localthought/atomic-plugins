import { describe, expect, it } from 'vitest';
import {
  handleBackgroundSyncEvent,
  registerBackgroundSync,
  type TickResult,
} from '../../../src/background/index.js';

describe('registerBackgroundSync', () => {
  it('registers periodic and one-shot sync when both are available', async () => {
    const calls: unknown[] = [];
    const result = await registerBackgroundSync(
      {
        periodicSync: {
          register: async (tag, options) => {
            calls.push(['periodic', tag, options]);
          },
        },
        sync: {
          register: async (tag) => {
            calls.push(['sync', tag]);
          },
        },
      },
      'github-issues',
      3_600_000,
    );
    expect(result).toEqual({ periodic: true, oneShot: true, errors: [] });
    expect(calls).toEqual([
      ['periodic', 'github-issues', { minInterval: 3_600_000 }],
      ['sync', 'github-issues'],
    ]);
  });

  it('reports refused and missing APIs without throwing', async () => {
    const refused = await registerBackgroundSync(
      {
        periodicSync: {
          register: async () => {
            throw new Error('Permission denied.');
          },
        },
      },
      't',
      1,
    );
    expect(refused).toEqual({
      periodic: false,
      oneShot: false,
      errors: ['periodic: Permission denied.'],
    });
    expect(await registerBackgroundSync({}, 't', 1)).toEqual({
      periodic: false,
      oneShot: false,
      errors: [],
    });
  });
});

describe('handleBackgroundSyncEvent', () => {
  it('ticks for its own tag, keeps the worker alive, and never rejects', async () => {
    const waited: Promise<unknown>[] = [];
    const results: TickResult[] = [];
    const ok: TickResult = { outcome: 'ran', state: { failures: 0 } };
    const event = (tag: string) => ({
      tag,
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    });
    expect(
      handleBackgroundSyncEvent(
        event('other'),
        { tick: async () => ok },
        'mine',
      ),
    ).toBe(false);
    expect(waited).toHaveLength(0);
    expect(
      handleBackgroundSyncEvent(
        event('mine'),
        { tick: async () => ok },
        'mine',
        (r) => results.push(r),
      ),
    ).toBe(true);
    handleBackgroundSyncEvent(
      event('mine'),
      {
        tick: async () => {
          throw new Error('store unavailable');
        },
      },
      'mine',
    );
    await Promise.all(waited);
    expect(results).toEqual([ok]);
  });
});
