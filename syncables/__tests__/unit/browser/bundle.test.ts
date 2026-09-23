import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../../../src/browser.ts', import.meta.url));
const nodeEntry = fileURLToPath(new URL('../../../src/index.ts', import.meta.url));

const builtins = new Set(builtinModules);
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtins.has(specifier.split('/')[0] as string);
}

/** Records every import of a Node built-in (and marks it external so the build can finish and report them all). */
function recordNodeImports(found: string[]): Plugin {
  return {
    name: 'record-node-imports',
    setup(pluginBuild): void {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (!isNodeBuiltin(args.path)) {
          return undefined;
        }
        found.push(`${args.path} (imported by ${args.importer})`);
        return { path: args.path, external: true };
      });
    },
  };
}

async function bundle(file: string): Promise<{ nodeImports: string[]; inputs: string[]; text: string }> {
  const nodeImports: string[] = [];
  const result = await build({
    entryPoints: [file],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [recordNodeImports(nodeImports)],
  });
  return {
    nodeImports,
    inputs: Object.keys(result.metafile.inputs),
    text: result.outputFiles[0]?.text ?? '',
  };
}

describe('syncables/browser bundle', () => {
  it('bundles for platform: browser without importing any Node built-in', async () => {
    const { nodeImports, inputs, text } = await bundle(entry);
    expect(nodeImports).toEqual([]);
    // Only this package's own sources: no js-yaml, no transitive dependency
    // that could pull a Node built-in in later.
    expect(inputs.every((input) => input.includes('src/') && !input.includes('node_modules'))).toBe(true);
    expect(inputs.some((input) => input.includes('mock-server') || input.includes('client/'))).toBe(false);
    // Node-only globals that a bundler would not shim either.
    expect(text).not.toMatch(/\bprocess\.|\bBuffer\.|\brequire\(/);
  });

  it('detects a Node built-in when one is imported (the check is not vacuous)', async () => {
    const { nodeImports } = await bundle(nodeEntry);
    expect(nodeImports.length).toBeGreaterThan(0);
    expect(nodeImports.some((line) => line.startsWith('node:http'))).toBe(true);
  });
});
