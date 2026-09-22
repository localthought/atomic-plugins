interface CollectionMeta {
  version: number;
  lastModified: string;
}

export class ResourceStore {
  private readonly collections = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private readonly meta = new Map<string, CollectionMeta>();

  has(resource: string): boolean {
    return this.collections.has(resource);
  }

  list(resource: string): Record<string, unknown>[] {
    return [...this.collection(resource).values()];
  }

  get(resource: string, id: string): Record<string, unknown> | undefined {
    return this.collection(resource).get(id);
  }

  put(resource: string, id: string, value: Record<string, unknown>): void {
    this.collection(resource).set(id, value);
    this.touch(resource);
  }

  delete(resource: string, id: string): boolean {
    const deleted = this.collection(resource).delete(id);
    if (deleted) {
      this.touch(resource);
    }
    return deleted;
  }

  /** Weak ETag for the current state of `resource`'s collection, once it has been populated at least once. */
  etag(resource: string): string | undefined {
    const meta = this.meta.get(resource);
    return meta ? `W/"${meta.version}"` : undefined;
  }

  /** RFC 7231 HTTP-date of the last mutation to `resource`'s collection, if any. */
  lastModified(resource: string): string | undefined {
    return this.meta.get(resource)?.lastModified;
  }

  private touch(resource: string): void {
    const current = this.meta.get(resource);
    this.meta.set(resource, {
      version: (current?.version ?? 0) + 1,
      lastModified: new Date().toUTCString(),
    });
  }

  private collection(resource: string): Map<string, Record<string, unknown>> {
    let collection = this.collections.get(resource);
    if (!collection) {
      collection = new Map();
      this.collections.set(resource, collection);
    }
    return collection;
  }
}
