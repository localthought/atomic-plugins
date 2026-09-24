/**
 * A tiny persisted string→string store. Used for per-pair reflection metadata
 * that has to survive restarts — notably the last agreed open/closed state of a
 * reflected issue pair, which is how state reflection tells which side changed.
 */
export interface KvStore {
  get(key: string): string | undefined;
  set(key: string, value: string): Promise<void> | void;
}

export class InMemoryKvStore implements KvStore {
  protected readonly map = new Map<string, string>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  protected record(key: string, value: string): void {
    this.map.set(key, value);
  }

  protected snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}
