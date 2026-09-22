import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { StorageAdapter } from 'syncables';

/**
 * A syncables `StorageAdapter` that keeps each record as an individual JSON
 * file on disk, under `<root>/<namespace>/<resource>/<id>.json`. This is the
 * "local-first" copy the UI reads from and the exact set of files the ZIP
 * download packages.
 *
 * `namespace` separates otherwise-identical resource keys: every per-calendar
 * events client shares the collection path `/calendars/{calendarId}/events`,
 * so the concrete calendar id is used as the namespace to stop calendars from
 * overwriting each other's events.
 */
export class FileStorageAdapter implements StorageAdapter {
  constructor(
    private readonly root: string,
    private readonly namespace: string,
  ) {}

  private dir(resource: string): string {
    return join(
      this.root,
      encodeURIComponent(this.namespace),
      encodeURIComponent(resource),
    );
  }

  private file(resource: string, id: string): string {
    return join(this.dir(resource), `${encodeURIComponent(id)}.json`);
  }

  async list(resource: string): Promise<Record<string, unknown>[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(resource));
    } catch {
      return [];
    }
    const items: Record<string, unknown>[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await readFile(join(this.dir(resource), name), 'utf8');
        items.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Skip unreadable/partial files rather than failing the whole listing.
      }
    }
    return items;
  }

  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = await readFile(this.file(resource, id), 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(this.dir(resource), { recursive: true });
    const target = this.file(resource, id);
    // Write to a temp file then rename, so a concurrent `list()`/`get()` never
    // observes a half-written file. syncables writes each record twice (once
    // locally, once after the server confirms), so these races are routine.
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async delete(resource: string, id: string): Promise<void> {
    await rm(this.file(resource, id), { force: true });
  }
}
