import { generateId } from '../src/sync/resources.js';
import {
  buildEventsClient,
  drainWrites,
  eventsModel,
  sleep,
} from './events-client.js';
import { FakePlatform, type PlatformRecord } from './fake-platform.js';

/** The private extendedProperties key each driven event is tagged with. */
const RUN_MARKER = 'reflectorRunId';
/** The private extendedProperties key recording which platform a record originated on. */
const ORIGIN_MARKER = 'reflectorOrigin';

/** What a test wants driven onto the source platform (id + marker are added). */
export interface EventInput {
  summary: string;
  start: Record<string, unknown>;
  end: Record<string, unknown>;
}

/** Reads the run marker off an event, if present. */
export function markerOf(event: PlatformRecord): string | undefined {
  const ext = event['extendedProperties'] as
    | { private?: Record<string, unknown> }
    | undefined;
  const value = ext?.private?.[RUN_MARKER];
  return typeof value === 'string' ? value : undefined;
}

/** Reads the origin-platform marker off an event, if present. */
export function originOf(event: PlatformRecord): string | undefined {
  const ext = event['extendedProperties'] as
    | { private?: Record<string, unknown> }
    | undefined;
  const value = ext?.private?.[ORIGIN_MARKER];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a run id off a record. Platforms with different record shapes keep it
 * in different places (Calendar in `extendedProperties.private`, the agenda
 * shape at top level), so readers are injected where records are shape-specific.
 */
export type MarkerReader = (record: PlatformRecord) => string | undefined;

/** Reads the run marker off an agenda-shaped record (top-level field). */
export function agendaMarkerOf(record: PlatformRecord): string | undefined {
  const value = record[RUN_MARKER];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Merges the run marker (and, if given, the origin-platform marker) into an
 * event's extendedProperties, preserving others.
 */
function withMarker(
  event: PlatformRecord,
  runId: string,
  origin?: string,
): PlatformRecord {
  const ext = (event['extendedProperties'] as Record<string, unknown>) ?? {};
  const priv = (ext['private'] as Record<string, unknown>) ?? {};
  const nextPriv: Record<string, unknown> = { ...priv, [RUN_MARKER]: runId };
  if (origin !== undefined) {
    nextPriv[ORIGIN_MARKER] = origin;
  }
  return {
    ...event,
    extendedProperties: { ...ext, private: nextPriv },
  };
}

/** Deletes every run-tagged record from a calendar on a platform (teardown). */
export function cleanupTagged(
  platform: FakePlatform,
  calendarId: string,
  runId: string,
  readMarker: MarkerReader = markerOf,
): void {
  for (const event of platform.events(calendarId)) {
    if (readMarker(event) === runId) {
      platform.deleteDirect(calendarId, String(event['id']));
    }
  }
}

/**
 * Drives data changes into the source platform, using syncables directly (not
 * the app's SyncEngine). Every event is tagged with the run id so the reviewer
 * and teardown can find exactly this run's records.
 */
export class Driver {
  constructor(
    private readonly platform: FakePlatform,
    private readonly calendarId: string,
  ) {}

  /** Creates the events and waits until they've actually landed on the platform. */
  async create(events: EventInput[], runId: string): Promise<PlatformRecord[]> {
    const model = await eventsModel();
    const { client, resource } = await buildEventsClient(
      this.platform.fetchFor(this.calendarId),
    );
    const created: PlatformRecord[] = [];
    for (const input of events) {
      const id = model.generatesId ? generateId(model.idPattern) : undefined;
      const payload = withMarker(
        id !== undefined ? { ...input, id } : { ...input },
        runId,
        this.platform.name,
      );
      created.push(await client.create(resource, payload));
    }
    // Wait for the background POSTs to settle, so the source really holds them
    // before the reflector reads it.
    await drainWrites(client, resource);
    return created;
  }
}

/**
 * The independent observer. Reads the target platform through fresh syncables
 * clients (fresh in-memory copy each poll, so it never trusts cached state)
 * and waits for the reflected records to appear.
 *
 * Note: reading through syncables means the reviewer shares syncables' read
 * path with the SUT. For a stronger, fully independent oracle, read the target
 * via its raw API instead — swap the body of `readTagged`.
 */
export class Reviewer {
  constructor(
    private readonly platform: FakePlatform,
    private readonly calendarId: string,
    /** How to read the run marker on the target's records (default: Calendar shape). */
    private readonly readMarker: MarkerReader = markerOf,
  ) {}

  /** Polls until at least `expected` run-tagged records are visible, or timeout. */
  async awaitReflected(
    runId: string,
    expected: number,
    opts: { timeoutMs: number; intervalMs: number },
  ): Promise<PlatformRecord[]> {
    const deadline = Date.now() + opts.timeoutMs;
    let seen: PlatformRecord[] = [];
    for (;;) {
      seen = await this.readTagged(runId);
      if (seen.length >= expected || Date.now() >= deadline) {
        return seen;
      }
      await sleep(opts.intervalMs);
    }
  }

  private async readTagged(runId: string): Promise<PlatformRecord[]> {
    const { client, resource } = await buildEventsClient(
      this.platform.fetchFor(this.calendarId),
    );
    await client.sync();
    const all = await client.list(resource);
    return all.filter((e) => this.readMarker(e) === runId);
  }
}

/** A reflection transform: how a source record should appear on the target. */
export type Mapping = (source: PlatformRecord) => PlatformRecord;

/** The correct Calendar→Calendar mapping: carry the content + marker, drop the source id. */
export const identityMapping: Mapping = (source) => ({
  summary: source['summary'],
  start: source['start'],
  end: source['end'],
  extendedProperties: source['extendedProperties'],
});

/** Pulls the ISO datetime out of a Calendar `start`/`end` object. */
function dateTimeOf(value: unknown): unknown {
  return (value as { dateTime?: unknown } | undefined)?.dateTime;
}

/**
 * The correct Calendar→Agenda mapping: a genuinely different target shape
 * (`{ title, startsAt, endsAt }` instead of `{ summary, start.dateTime,
 * end.dateTime }`), carrying the run marker into the agenda shape's top-level
 * field. This is what makes the mapping oracle non-trivial.
 */
export const calendarToAgenda: Mapping = (source) => ({
  title: source['summary'],
  startsAt: dateTimeOf(source['start']),
  endsAt: dateTimeOf(source['end']),
  [RUN_MARKER]: markerOf(source),
});

export interface StubReflectorOptions {
  source: FakePlatform;
  sourceCalendar: string;
  target: FakePlatform;
  targetCalendar: string;
  /** How the reflector maps a source record to the target. Defaults to identity. */
  mapping?: Mapping;
  /** Delay before the reflection is applied, simulating async SUT processing. */
  reflectDelayMs?: number;
}

/**
 * Stands in for the system under test: a separate Reflector instance that
 * reflects the source platform onto the target. `reflectNow()` is the seam —
 * replace it with a trigger to the real SUT's "reflect now" endpoint.
 *
 * Like a real reflector it reads the source and writes the target through
 * syncables; it does NOT share the oracle's notion of correctness (its
 * `mapping` is its own implementation), so a wrong mapping is a real bug the
 * reviewer must catch.
 */
export class StubReflector {
  readonly targetPlatform: FakePlatform;
  readonly targetCalendarId: string;
  private readonly mapping: Mapping;
  private readonly delayMs: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StubReflectorOptions) {
    this.targetPlatform = opts.target;
    this.targetCalendarId = opts.targetCalendar;
    this.mapping = opts.mapping ?? identityMapping;
    this.delayMs = opts.reflectDelayMs ?? 0;
  }

  /** Triggers reflection of this run's records and returns immediately. */
  reflectNow(runId: string): void {
    this.pending = this.pending.then(() => this.reflect(runId));
  }

  /** Resolves once any in-flight reflection has finished (for teardown). */
  async idle(): Promise<void> {
    await this.pending;
  }

  private async reflect(runId: string): Promise<void> {
    if (this.delayMs) {
      await sleep(this.delayMs);
    }
    const read = await buildEventsClient(
      this.opts.source.fetchFor(this.opts.sourceCalendar),
    );
    await read.client.sync();
    const sourceEvents = await read.client.list(read.resource);

    const write = await buildEventsClient(
      this.opts.target.fetchFor(this.opts.targetCalendar),
    );
    for (const event of sourceEvents) {
      if (markerOf(event) !== runId) {
        continue; // only this run's records; a real reflector detects changes
      }
      await write.client.create(write.resource, this.mapping(event));
    }
    await drainWrites(write.client, write.resource);
  }
}

/** One side of a bidirectional reflection: a platform and the calendar on it. */
export interface Endpoint {
  platform: FakePlatform;
  calendar: string;
}

export interface BidirectionalReflectorOptions {
  a: Endpoint;
  b: Endpoint;
  /** Reflection transform applied to each record (defaults to identity). */
  mapping?: Mapping;
  /**
   * When true (the default), a record whose origin is not the platform being
   * read is treated as an echo and skipped — this is the loop suppression under
   * test. Set false to model a reflector that lacks it and pings-pongs.
   */
  suppressEchoes?: boolean;
  /** Delay before a reflect cycle is applied, simulating async SUT processing. */
  reflectDelayMs?: number;
}

/**
 * A bidirectional stand-in reflector (A↔B) with the loop suppression a real
 * Reflector needs: it never reflects the same source record twice
 * (idempotent), and it skips echoes — records that originated on the other
 * platform, which reflecting onward would bounce back and forth forever.
 *
 * Toggle `suppressEchoes` off to model the ping-pong bug the loop scenario is
 * meant to catch.
 */
export class BidirectionalReflector {
  private readonly mapping: Mapping;
  private readonly suppress: boolean;
  private readonly delayMs: number;
  /** Keys (`<platform>:<id>`) already reflected, so repeated cycles are idempotent. */
  private readonly reflected = new Set<string>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: BidirectionalReflectorOptions) {
    this.mapping = opts.mapping ?? identityMapping;
    this.suppress = opts.suppressEchoes ?? true;
    this.delayMs = opts.reflectDelayMs ?? 0;
  }

  /** Triggers one full A→B then B→A cycle for this run and returns immediately. */
  reflectNow(runId: string): void {
    this.pending = this.pending.then(() => this.reflectBoth(runId));
  }

  /** Resolves once any in-flight reflection has finished (for teardown). */
  async idle(): Promise<void> {
    await this.pending;
  }

  private async reflectBoth(runId: string): Promise<void> {
    if (this.delayMs) {
      await sleep(this.delayMs);
    }
    await this.reflectOnce(this.opts.a, this.opts.b, runId);
    await this.reflectOnce(this.opts.b, this.opts.a, runId);
  }

  private async reflectOnce(
    from: Endpoint,
    to: Endpoint,
    runId: string,
  ): Promise<void> {
    const read = await buildEventsClient(from.platform.fetchFor(from.calendar));
    await read.client.sync();
    const records = await read.client.list(read.resource);

    const write = await buildEventsClient(to.platform.fetchFor(to.calendar));
    let wrote = false;
    for (const record of records) {
      if (markerOf(record) !== runId) {
        continue; // only this run's records
      }
      // Echo: this record originated elsewhere (it was reflected onto `from`),
      // so reflecting it onward would start a loop.
      if (this.suppress && originOf(record) !== from.platform.name) {
        continue;
      }
      // Idempotent: never reflect the same source record twice.
      const key = `${from.platform.name}:${String(record['id'])}`;
      if (this.reflected.has(key)) {
        continue;
      }
      this.reflected.add(key);
      await write.client.create(write.resource, this.mapping(record));
      wrote = true;
    }
    if (wrote) {
      await drainWrites(write.client, write.resource);
    }
  }
}
