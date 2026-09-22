import { join } from 'node:path';
import {
  ReflectionEngine,
  ReflectionRunner,
  type ReflectionSide,
  type ReflectionSummary,
} from 'devonian/reflect';
import type { ReflectionEndpoint, ReflectorConfig } from '../config/index.js';
import { deriveApiBase } from '../oauth/oauth.js';
import { StaticTokenManager } from '../oauth/static-token.js';
import { buildDocumentFrom } from '../sync/document.js';
import { discoverResourceModel } from '../sync/resources.js';
import { buildReflectionSide, type SideConfig } from './sides.js';
import { FileIdMap } from './id-map.js';
import { FileKvStore } from './kv-store.js';

/**
 * Extracts `[owner, repo]` from a reflection target: either the documented
 * "owner/repo" shorthand, or a full repository URL (e.g.
 * `https://github.com/owner/repo`, optionally with a trailing `/issues`,
 * `.git`, or `/`) — pasting the browser URL instead of the shorthand is an
 * easy mistake (localthought/reflector#31), so it's accepted rather than
 * silently mis-parsed.
 */
function parseOwnerRepo(target: string): [string, string] | undefined {
  if (!target.includes('://')) {
    const parts = target.split('/');
    return parts.length === 2 && parts[0] && parts[1]
      ? [parts[0], parts[1]]
      : undefined;
  }
  try {
    const parts = new URL(target).pathname.split('/').filter(Boolean);
    return parts.length >= 2
      ? [parts[0], parts[1].replace(/\.git$/, '')]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a reflection target into the path context the document expects. */
function targetContext(target: string): Record<string, string> {
  const parsed = parseOwnerRepo(target);
  if (!parsed) {
    throw new Error(
      `Reflection target "${target}" must be in "owner/repo" form, or a ` +
        'full repository URL (e.g. "https://github.com/owner/repo").',
    );
  }
  const [owner, repo] = parsed;
  return { owner, repo };
}

async function buildSide(
  endpoint: ReflectionEndpoint,
  retry: SideConfig['retry'],
): Promise<ReflectionSide> {
  const document = await buildDocumentFrom(
    endpoint.openApiPath,
    endpoint.overlayDir,
  );
  const model = discoverResourceModel(document);
  const auth = new StaticTokenManager(deriveApiBase(document), endpoint.token);
  return buildReflectionSide({
    system: endpoint.target,
    document,
    model,
    auth,
    context: targetContext(endpoint.target),
    retry,
  });
}

/**
 * Runs `devonian`'s generic reflection engine on reflector's config: builds
 * the two `ReflectionSide`s from this app's document/overlay/OAuth machinery
 * (the half `devonian` deliberately knows nothing about — localthought/
 * atomic-plugins#6), then wraps the resulting engine in a `ReflectionRunner`
 * for the background loop, on-demand trigger, and status reporting that
 * `src/server/app.ts`'s `/api/reflect*` routes and `src/main.ts` use.
 */
export class ReflectionService {
  private constructor(private readonly runner: ReflectionRunner) {}

  /** Builds the service from config, or `undefined` when reflection is off. */
  static async fromConfig(
    config: ReflectorConfig,
  ): Promise<ReflectionService | undefined> {
    if (!config.reflection.enabled) {
      return undefined;
    }
    const [a, b] = await Promise.all([
      buildSide(config.reflection.a, config.retry),
      buildSide(config.reflection.b, config.retry),
    ]);
    const dir = join(config.dataDir, 'reflect');
    const idMap = await FileIdMap.open(join(dir, 'id-map.json'));
    const stateLedger = await FileKvStore.open(join(dir, 'state.json'));
    const engine = new ReflectionEngine(a, b, idMap, {
      direction: config.reflection.direction,
      maxAttempts: config.retry.maxAttempts,
      stateLedger,
      // reflector's markers predate devonian; keep the established tag so
      // records already reflected in production keep parsing.
      namespace: 'reflector',
    });
    const runner = new ReflectionRunner(
      engine,
      config.reflection.intervalMs,
      config.reflection.direction,
      [a.system, b.system],
    );
    return new ReflectionService(runner);
  }

  /** Triggers one reflection pass, serialized with the loop and other triggers. */
  reflectNow(): Promise<ReflectionSummary> {
    return this.runner.reflectNow();
  }

  /** Starts the background loop (an immediate pass, then every `intervalMs`). */
  start(): void {
    this.runner.start();
  }

  stop(): void {
    this.runner.stop();
  }

  status(): ReturnType<ReflectionRunner['status']> {
    return this.runner.status();
  }
}
