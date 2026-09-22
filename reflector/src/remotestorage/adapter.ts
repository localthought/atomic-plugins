import type { StorageAdapter } from 'syncables';
import type { ExportRecord, StorageBackend } from '../sync/storage.js';
import {
  decodeSegment,
  encodeSegment,
  getDocument,
  listFolder,
} from './protocol.js';

/**
 * A syncables {@link StorageAdapter} backed by the user's remoteStorage
 * account. Each record is one JSON document at
 * `<base>/<namespace>/<resource>/<id>`, mirroring {@link FileStorageAdapter}'s
 * on-disk layout but over the remoteStorage HTTP protocol. `base` already
 * includes the app's storage module (e.g. `https://storage.example/me/reflector`),
 * so everything Reflector writes stays inside the scope the user granted.
 */
export class RemoteStorageAdapter implements StorageAdapter {
  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch,
    private readonly namespace: string,
  ) {}

  private folderUrl(resource: string): string {
    return `${this.base}/${encodeSegment(this.namespace)}/${encodeSegment(resource)}/`;
  }

  private docUrl(resource: string, id: string): string {
    return `${this.base}/${encodeSegment(this.namespace)}/${encodeSegment(resource)}/${encodeSegment(id)}`;
  }

  async list(resource: string): Promise<Record<string, unknown>[]> {
    const { documents } = await listFolder(
      this.fetchImpl,
      this.folderUrl(resource),
    );
    const items: Record<string, unknown>[] = [];
    for (const name of documents) {
      // Folder-listing keys are the encoded ids we wrote, so decode before GET.
      const value = await this.get(resource, decodeSegment(name));
      if (value) {
        items.push(value);
      }
    }
    return items;
  }

  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    return getDocument(this.fetchImpl, this.docUrl(resource, id));
  }

  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.fetchImpl(this.docUrl(resource, id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!response.ok) {
      throw new Error(
        `remoteStorage PUT failed with status ${response.status}: ${resource}/${id}`,
      );
    }
  }

  async delete(resource: string, id: string): Promise<void> {
    const response = await this.fetchImpl(this.docUrl(resource, id), {
      method: 'DELETE',
    });
    // A 404 is fine: the document is already gone.
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `remoteStorage DELETE failed with status ${response.status}: ${resource}/${id}`,
      );
    }
  }
}

/**
 * The {@link StorageBackend} that stores the local-first copy in the user's
 * remoteStorage account. Enumeration for the ZIP walks the same
 * namespace/resource/document folder tree the adapter writes.
 */
export class RemoteStorageBackend implements StorageBackend {
  readonly label: string;

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch,
    userAddress: string,
  ) {
    this.label = `remoteStorage: ${userAddress}`;
  }

  adapter(namespace: string): StorageAdapter {
    return new RemoteStorageAdapter(this.base, this.fetchImpl, namespace);
  }

  async enumerate(): Promise<ExportRecord[]> {
    const records: ExportRecord[] = [];
    const namespaces = await listFolder(this.fetchImpl, `${this.base}/`);
    for (const namespace of namespaces.folders) {
      const nsUrl = `${this.base}/${namespace}/`;
      const resources = await listFolder(this.fetchImpl, nsUrl);
      for (const resource of resources.folders) {
        const resUrl = `${nsUrl}${resource}/`;
        const { documents } = await listFolder(this.fetchImpl, resUrl);
        for (const document of documents) {
          const value = await getDocument(
            this.fetchImpl,
            `${resUrl}${document}`,
          );
          if (value) {
            records.push({
              namespace: decodeSegment(namespace),
              resource: decodeSegment(resource),
              id: decodeSegment(document),
              value,
            });
          }
        }
      }
    }
    return records;
  }
}
