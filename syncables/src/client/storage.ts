export interface StorageAdapter {
  list(resource: string): Promise<Record<string, unknown>[]>;
  get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined>;
  put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void>;
  delete(resource: string, id: string): Promise<void>;
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly collections = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  async list(resource: string): Promise<Record<string, unknown>[]> {
    return [...this.collection(resource).values()];
  }

  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.collection(resource).get(id);
  }

  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.collection(resource).set(id, value);
  }

  async delete(resource: string, id: string): Promise<void> {
    this.collection(resource).delete(id);
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
