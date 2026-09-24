// @wc-ignore-file
/**
 * Wall-clock list bounds and the UTC span they cover, including the two
 * DST changes of 2026 in Europe/Amsterdam: 29 March (02:00–03:00 local is
 * skipped) and 25 October (02:00–03:00 local happens twice).
 */
import { describe, expect, it } from 'vitest';
import { rangeBounds, saysDeleted } from './clockifyObserve.js';
import {
  instantsOf,
  isTimeZone,
  wallClock,
  wallClockParam,
  zoneOffsetMs,
} from './timeZone.js';
import { ProxyError } from './transport.js';

const TZ = 'Europe/Amsterdam';
const at = (text: string) => Date.parse(text);
const HOUR = 3_600_000;

describe('wall-clock time in the profile time zone', () => {
  it('formats an instant as local digits with the Z Clockify ignores', () => {
    expect(wallClockParam(at('2026-09-26T22:30:00Z'), TZ)).toBe(
      '2026-09-27T00:30:00Z',
    );
    expect(wallClockParam(at('2026-01-10T12:00:00.999Z'), TZ)).toBe(
      '2026-01-10T13:00:00Z',
    );
    expect(zoneOffsetMs(at('2026-07-01T00:00:00Z'), TZ)).toBe(2 * HOUR);
    expect(zoneOffsetMs(at('2026-12-01T00:00:00Z'), TZ)).toBe(HOUR);
  });

  it('knows real zone names only', () => {
    expect(isTimeZone(TZ)).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone(undefined)).toBe(false);
  });

  it('gives both instants of a repeated hour, and both readings of a skipped one', () => {
    // 25 October: 02:30 local is 00:30Z (CEST) and 01:30Z (CET).
    expect(instantsOf(at('2026-10-25T02:30:00Z'), TZ)).toEqual([
      at('2026-10-25T00:30:00Z'),
      at('2026-10-25T01:30:00Z'),
    ]);
    // 29 March: 02:30 local does not exist; 00:30Z (+2) or 01:30Z (+1).
    expect(instantsOf(at('2026-03-29T02:30:00Z'), TZ)).toEqual([
      at('2026-03-29T00:30:00Z'),
      at('2026-03-29T01:30:00Z'),
    ]);
    // An ordinary time has one.
    expect(instantsOf(at('2026-03-29T03:30:00Z'), TZ)).toEqual([
      at('2026-03-29T01:30:00Z'),
    ]);

    // Round trip for every hour of both DST days.
    for (const day of ['2026-03-29', '2026-10-25'])
      for (let h = 0; h < 24; h++) {
        const instant = at(`${day}T00:00:00Z`) + h * HOUR;
        expect(instantsOf(wallClock(instant, TZ), TZ)).toContain(instant);
      }
  });
});

describe('rangeBounds: what a read claims to cover', () => {
  it('is the exact UTC window on an ordinary day', () => {
    const b = rangeBounds(
      at('2026-09-15T12:00:00.500Z'),
      at('2026-09-23T12:00:00Z'),
      TZ,
    );

    expect(b.query).toEqual({
      start: '2026-09-15T14:00:00Z',
      end: '2026-09-23T14:00:00Z',
    });
    expect([b.from, b.to]).toEqual([
      at('2026-09-15T12:00:00Z'),
      at('2026-09-23T12:00:00Z'),
    ]);
  });

  it('claims the smaller span when a bound falls in the repeated hour', () => {
    // Both bounds read "02:30": the first time for start, the second for end.
    const b = rangeBounds(
      at('2026-10-25T00:30:00Z'),
      at('2026-10-25T01:30:00Z'),
      TZ,
    );

    expect(b.query).toEqual({
      start: '2026-10-25T02:30:00Z',
      end: '2026-10-25T02:30:00Z',
    });
    // Clockify may read start as the later and end as the earlier instant.
    expect(b.from).toBe(at('2026-10-25T01:30:00Z'));
    expect(b.to).toBe(at('2026-10-25T00:30:00Z'));
  });

  it('is exact across the skipped hour: an instant never falls in it', () => {
    const b = rangeBounds(
      at('2026-03-29T00:30:00Z'),
      at('2026-03-29T01:30:00Z'),
      TZ,
    );

    expect(b.query).toEqual({
      start: '2026-03-29T01:30:00Z',
      end: '2026-03-29T03:30:00Z',
    });
    expect([b.from, b.to]).toEqual([
      at('2026-03-29T00:30:00Z'),
      at('2026-03-29T01:30:00Z'),
    ]);
  });

  it('narrows by 14 h at each end when the time zone is unknown', () => {
    const b = rangeBounds(
      at('2026-09-15T12:00:00Z'),
      at('2026-09-23T12:00:00Z'),
      undefined,
    );

    expect(b.query.start).toBe('2026-09-15T12:00:00Z');
    expect([b.from, b.to]).toEqual([
      at('2026-09-16T02:00:00Z'),
      at('2026-09-22T22:00:00Z'),
    ]);
  });
});

describe('saysDeleted: what confirms a deletion', () => {
  const failed = (status: number, body: unknown) =>
    new ProxyError('/x', status, body);

  it('is Clockify’s 400 "doesn’t belong to Workspace", or a 404 from Clockify', () => {
    expect(
      saysDeleted(
        failed(400, {
          message: "Time entry doesn't belong to Workspace",
          code: 501,
        }),
      ),
    ).toBe(true);
    expect(saysDeleted(failed(404, { message: 'Not found' }))).toBe(true);
  });

  it('is not any other 400, the proxy’s own 404, or another failure', () => {
    expect(saysDeleted(failed(400, { message: 'Bad request' }))).toBe(false);
    expect(
      saysDeleted(failed(404, 'method or path is not in the catalog')),
    ).toBe(false);
    expect(saysDeleted(failed(503, {}))).toBe(false);
    expect(saysDeleted(new Error('network'))).toBe(false);
  });
});
