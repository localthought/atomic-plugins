/**
 * Low-level helpers for talking the remoteStorage HTTP protocol
 * (https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage) over a
 * plain `fetch`. Documents are read/written/deleted at a URL; a URL ending in
 * `/` is a folder whose GET returns a JSON listing of its immediate children.
 *
 * Every namespace / resource / record id Reflector stores is encoded into a
 * single path segment with `encodeSegment`, mirroring the on-disk layout of
 * {@link FileStorageAdapter}, so a folder listing's keys map straight back to
 * those values with `decodeSegment`.
 */

/** Encodes an arbitrary string as one remoteStorage path segment (no `/`). */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Reverses {@link encodeSegment}; returns the input unchanged if it will not decode. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The immediate children of a folder, split into sub-folders and documents. */
export interface FolderEntries {
  /** Child folder names, with their trailing `/` stripped. */
  folders: string[];
  /** Child document names. */
  documents: string[];
}

/** Shape of a remoteStorage folder-description document. */
interface FolderDescription {
  items?: Record<string, unknown>;
}

/**
 * Lists a folder's immediate children. A missing folder (`404`) lists as
 * empty, matching the filesystem backend where a never-written directory
 * simply has no entries.
 */
export async function listFolder(
  fetchImpl: typeof fetch,
  folderUrl: string,
): Promise<FolderEntries> {
  const response = await fetchImpl(folderUrl, {
    headers: { Accept: 'application/ld+json' },
  });
  if (response.status === 404) {
    return { folders: [], documents: [] };
  }
  if (!response.ok) {
    throw new Error(
      `remoteStorage folder listing failed with status ${response.status}: ${folderUrl}`,
    );
  }
  const body = (await response.json()) as FolderDescription;
  const folders: string[] = [];
  const documents: string[] = [];
  for (const name of Object.keys(body.items ?? {})) {
    if (name.endsWith('/')) {
      folders.push(name.slice(0, -1));
    } else {
      documents.push(name);
    }
  }
  return { folders, documents };
}

/** GETs a JSON document, returning `undefined` for a `404`. */
export async function getDocument(
  fetchImpl: typeof fetch,
  documentUrl: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchImpl(documentUrl, {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `remoteStorage GET failed with status ${response.status}: ${documentUrl}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}
