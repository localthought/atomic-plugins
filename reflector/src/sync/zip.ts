import JSZip from 'jszip';
import type { ExportRecord } from './storage.js';

/** Builds the readable, nested path a record takes inside the archive. */
function zipPath(record: ExportRecord): string {
  // The namespace is the concrete value of the resource's templated id — the
  // calendar id for per-calendar event resources (the calendar list uses
  // `_account`, and its path has no template). Fill any `{param}` in the
  // resource path with it so the archive shows the real calendar id instead of
  // a literal `{calendarId}` folder.
  // e.g. "primary" / "/calendars/{calendarId}/events" / "e1"
  //   -> "primary/calendars/primary/events/e1.json"
  const resource = record.resource
    .replace(/^\/+/, '')
    .replace(/\{[^/}]+\}/g, record.namespace);
  return [record.namespace, resource, `${record.id}.json`]
    .filter((part) => part.length > 0)
    .join('/');
}

/**
 * Packages an entire local-first copy into a ZIP: one JSON file per record,
 * grouped by account/calendar and resource. The records come from whichever
 * {@link StorageBackend} is active (on-disk files or the user's remoteStorage
 * account), so the download works the same regardless of where data lives.
 * A side feature alongside the app's main job of syncing systems of record.
 */
export async function buildZip(records: ExportRecord[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const record of records) {
    zip.file(zipPath(record), JSON.stringify(record.value, null, 2));
  }
  zip.file(
    'README.txt',
    [
      'Reflector export',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Records: ${records.length}`,
      '',
      'This archive is a full local copy of your Google Calendar data as read',
      'by Reflector. Each JSON file is one record (a calendar list entry or an',
      'event), grouped by calendar and resource.',
      '',
    ].join('\n'),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
