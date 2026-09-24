// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { applyCalendarEdit } from './sync.js';

const IMPORT_BASELINE = 'https://atomicdata.dev/properties/importBaseline';

describe('calendar write-back', () => {
  it('writes edits without emailing guests about them', async () => {
    const paths: string[] = [];
    await applyCalendarEdit(
      {
        subject: 'local:e1',
        name: 'After',
        path: '/calendars/primary/events/e1',
        etag: '"e1"',
        patch: { summary: 'After' },
        observed: {},
        acknowledged: {},
      },
      async () => ({ [IMPORT_BASELINE]: { values: {} } }),
      async path => {
        paths.push(path);

        return { status: 200, body: JSON.stringify({ summary: 'After' }) };
      },
      async () => undefined,
    );
    expect(paths).toEqual(['/calendars/primary/events/e1?sendUpdates=none']);
  });
});
