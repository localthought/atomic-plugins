// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { RawTimeEntry } from './clockifyApi.js';
import { projectEntries } from './project.js';

const entry = (over: Partial<RawTimeEntry> & { id: string }): RawTimeEntry => ({
  description: 'Work',
  userId: 'u1',
  projectId: 'p1',
  billable: true,
  type: 'REGULAR',
  timeInterval: { start: '2026-09-22T09:00:00Z', end: '2026-09-22T10:00:00Z' },
  ...over,
});

describe('projectEntries (through the devonian Clockify lens)', () => {
  it('resolves project and member names fetched in the same batch', () => {
    const [row] = projectEntries(
      [entry({ id: 'e1', description: '  Write docs  ' })],
      [{ id: 'p1', name: 'Atomic' }],
      [{ id: 'u1', name: 'Test Person' }],
    );

    expect(row).toEqual({
      entryId: 'e1',
      name: 'Write docs',
      start: Date.parse('2026-09-22T09:00:00Z'),
      end: Date.parse('2026-09-22T10:00:00Z'),
      billable: true,
      projectId: 'p1',
      projectName: 'Atomic',
      memberId: 'u1',
      memberName: 'Test Person',
    });
  });

  it('keeps a dangling reference as a raw id', () => {
    const [row] = projectEntries(
      [entry({ id: 'e1', projectId: 'gone' })],
      [],
      [],
    );

    expect(row.projectId).toBe('gone');
    expect(row.projectName).toBeUndefined();
  });

  it('skips breaks and running timers, and names an undescribed entry', () => {
    const rows = projectEntries(
      [
        entry({ id: 'break', type: 'BREAK' }),
        entry({
          id: 'running',
          timeInterval: { start: '2026-09-22T09:00:00Z', end: null },
        }),
        entry({ id: 'blank', description: null }),
      ],
      [],
      [],
    );

    expect(rows.map(r => [r.entryId, r.name])).toEqual([
      ['blank', 'Time entry'],
    ]);
  });

  it('rejects an entry that ends before it starts', () => {
    expect(() =>
      projectEntries(
        [
          entry({
            id: 'bad',
            timeInterval: {
              start: '2026-09-22T10:00:00Z',
              end: '2026-09-22T09:00:00Z',
            },
          }),
        ],
        [],
        [],
      ),
    ).toThrow(/ends before it starts/);
  });
});
