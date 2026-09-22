import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { FileStorageBackend } from '../../src/sync/storage.js';
import { buildZip } from '../../src/sync/zip.js';

describe('buildZip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-zip-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('packages the local copy into a readable archive', async () => {
    const backend = new FileStorageBackend(dir);
    await backend
      .adapter('primary')
      .put('/calendars/{calendarId}/events', 'e1', { id: 'e1', summary: 'One' });
    // A calendar id can itself contain characters that get percent-encoded on
    // disk (the primary calendar's id is the account email), so make sure the
    // decoded id lands in the path in place of `{calendarId}`.
    await backend
      .adapter('michiel@unhosted.org')
      .put('/calendars/{calendarId}/events', 'e2', { id: 'e2', summary: 'Two' });
    await backend
      .adapter('_account')
      .put('/users/me/calendarList', 'primary', { id: 'primary' });

    const buffer = await buildZip(await backend.enumerate());
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);

    expect(names).toContain('README.txt');
    // Paths are decoded to readable, nested form grouped by namespace/resource,
    // with the `{calendarId}` template filled in from the namespace so the
    // archive shows the real calendar id instead of a literal placeholder.
    expect(names).toContain('primary/calendars/primary/events/e1.json');
    expect(names).toContain(
      'michiel@unhosted.org/calendars/michiel@unhosted.org/events/e2.json',
    );
    expect(names).not.toContain('primary/calendars/{calendarId}/events/e1.json');
    expect(names).toContain('_account/users/me/calendarList/primary.json');

    const content = await zip
      .file('primary/calendars/primary/events/e1.json')
      ?.async('string');
    expect(JSON.parse(content ?? '{}')).toMatchObject({ summary: 'One' });
  });

  it('produces an archive with just a README when there is no data', async () => {
    const backend = new FileStorageBackend(dir);
    const zip = await JSZip.loadAsync(await buildZip(await backend.enumerate()));
    expect(Object.keys(zip.files)).toEqual(['README.txt']);
  });
});
