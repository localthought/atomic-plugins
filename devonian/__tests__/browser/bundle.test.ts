/**
 * Proves every public entry point of the package runs in a browser:
 *
 * 1. Each `exports` subpath is bundled with esbuild `platform: 'browser'` and
 *    no Node polyfills; a plugin fails the build on any import of a Node
 *    built-in (`node:*` or a bare `fs`, `events`, ...).
 * 2. A small driver per entry point (fixtures/*.mjs) is bundled the same way
 *    and run in a `node:vm` context that has the browser globals it needs
 *    (timers, `structuredClone`, `TextEncoder`, `URL`, `crypto`) and none of
 *    Node's (`process`, `Buffer`, `require`, `module`, `global`).
 *
 * The bare `devonian*` specifiers resolve through package.json's own
 * `exports`, honouring the `browser` condition, so the export map is under
 * test too. By default each `./build/src/X.js` target is mapped back to
 * `src/X.ts` so this runs before `pnpm build`; with DEVONIAN_TEST_BUILD=1
 * (set by CI after `pnpm build`) the compiled `build/` output is bundled
 * instead, which is what npm consumers get.
 *
 * Not covered: a real browser engine (no Playwright in this package), and
 * the service-worker registration path, which stays covered by the unit
 * tests with fakes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, type Metafile, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  exports: Record<string, string | Record<string, string>>;
};
const useBuild = process.env.DEVONIAN_TEST_BUILD === '1';

const nodeBuiltins = new Set(builtinModules);
function isNodeBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    nodeBuiltins.has(specifier) ||
    nodeBuiltins.has(specifier.split('/')[0]!)
  );
}

/** The file a subpath resolves to under the given export conditions. */
function exportTarget(subpath: string, conditions: string[]): string {
  const entry = pkg.exports[subpath];
  if (entry === undefined) throw new Error(`no export ${subpath}`);
  let target: string | undefined;
  if (typeof entry === 'string') {
    target = entry;
  } else {
    const condition = [...conditions, 'default'].find((c) => c in entry);
    target = condition === undefined ? undefined : entry[condition];
  }
  if (target === undefined) throw new Error(`no target for ${subpath}`);
  const file = useBuild
    ? `${root}${target.slice(2)}`
    : `${root}${target.slice(2).replace(/^build\/(src\/.*)\.js$/, '$1.ts')}`;
  if (!existsSync(file)) throw new Error(`${subpath} -> missing ${file}`);
  return file;
}

function plugins(conditions: string[], nodeImports: string[]): Plugin[] {
  return [
    {
      name: 'devonian-exports',
      setup(b): void {
        b.onResolve({ filter: /^devonian(\/.*)?$/ }, (args) => ({
          path: exportTarget(
            args.path === 'devonian'
              ? '.'
              : `./${args.path.slice('devonian/'.length)}`,
            conditions,
          ),
        }));
      },
    },
    {
      name: 'no-node-builtins',
      setup(b): void {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (!isNodeBuiltin(args.path)) return undefined;
          nodeImports.push(
            `${args.path} <- ${args.importer.replace(root, '')}`,
          );
          return { errors: [{ text: `Node built-in ${args.path}` }] };
        });
      },
    },
  ];
}

async function bundle(
  entry: string,
  format: 'esm' | 'iife',
  conditions = ['browser'],
): Promise<{ text: string; metafile: Metafile; nodeImports: string[] }> {
  const nodeImports: string[] = [];
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      conditions,
      format,
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
      plugins: plugins(conditions, nodeImports),
    });
    return {
      text: result.outputFiles[0]!.text,
      metafile: result.metafile,
      nodeImports,
    };
  } catch (error) {
    if (nodeImports.length > 0) return { text: '', metafile: { inputs: {}, outputs: {} }, nodeImports };
    throw error;
  }
}

/** Packages (by node_modules name) that ended up in a bundle. */
function packagesIn(metafile: Metafile): string[] {
  return [
    ...new Set(
      Object.keys(metafile.inputs)
        .filter((input) => input.includes('node_modules/'))
        .map((input) =>
          input.replace(/.*node_modules\/((?:@[^/]+\/)?[^/]+).*/, '$1'),
        ),
    ),
  ].sort();
}

/** A context with browser-provided globals only: no Node ones. */
function browserLikeContext(): vm.Context {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    EventTarget,
    Event,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
  });
  vm.runInContext('globalThis.self = globalThis.window = globalThis;', context);
  return context;
}

const subpaths = Object.keys(pkg.exports).filter(
  (subpath) => subpath !== './package.json',
);
const drivers: Record<string, string> = {
  '.': 'root',
  './atomic': 'atomic',
  './background': 'background',
  './reflect': 'reflect',
};

describe(`browser bundles (${useBuild ? 'build/' : 'src/'})`, () => {
  it('has a driver for every exported entry point', () => {
    expect(Object.keys(drivers).sort()).toEqual([...subpaths].sort());
  });

  it.each(subpaths)(
    '%s bundles for the browser without Node built-ins',
    async (subpath) => {
      const { nodeImports, text } = await bundle(
        exportTarget(subpath, ['browser']),
        'esm',
      );
      expect(nodeImports).toEqual([]);
      expect(text.length).toBeGreaterThan(0);
    },
  );

  it('the guard catches Node built-ins (reflect without the browser condition)', async () => {
    const { nodeImports } = await bundle(exportTarget('./reflect', []), 'esm', []);
    expect(nodeImports.some((i) => i.startsWith('node:fs/promises'))).toBe(
      true,
    );
  });

  it('never bundles Automerge from any entry point', async () => {
    for (const subpath of subpaths) {
      const { metafile } = await bundle(exportTarget(subpath, ['browser']), 'esm');
      expect(packagesIn(metafile).filter((p) => p.startsWith('@automerge/'))).toEqual([]);
    }
  });

  it('keeps devonian/atomic free of effect and the row API', async () => {
    const { metafile, text } = await bundle(
      `${root}__tests__/browser/fixtures/atomic.mjs`,
      'esm',
    );
    expect(packagesIn(metafile)).toEqual(['@tomic/lib']);
    expect(text).not.toContain('DevonianTable');
  });

  it('the vm context has no Node globals', () => {
    const context = browserLikeContext();
    expect(
      vm.runInContext(
        '[typeof process, typeof Buffer, typeof require, typeof module, typeof global]',
        context,
      ),
    ).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it.each(Object.entries(drivers))(
    '%s runs in a browser-like context',
    async (subpath, driver) => {
      const { text, nodeImports } = await bundle(
        `${root}__tests__/browser/fixtures/${driver}.mjs`,
        'iife',
      );
      expect(nodeImports).toEqual([]);
      const context = browserLikeContext();
      vm.runInContext(text, context, { filename: `${driver}.bundle.js` });
      const result = JSON.parse(
        JSON.stringify(await (context.__result as Promise<unknown>)),
      );
      expect(result).toEqual(expected[subpath]);
    },
  );
});

const expected: Record<string, unknown> = {
  '.': {
    rightAdded: ['Anvil'],
    seen: ['once:1', 'on:1', 'on:2'],
    resources: 1,
    reconcileRecord: 'function',
  },
  './atomic': {
    published: 't1',
    name: 'Rocket',
    count: 1,
    unbound: 't1',
    bound: null,
  },
  './background': { runs: 1, outcome: 'ran', stored: true },
  './reflect': {
    counterpart: { system: 'b', id: '9' },
    kv: 'v',
    origin: { system: 'a', kind: 'issue', id: '1' },
  },
};
