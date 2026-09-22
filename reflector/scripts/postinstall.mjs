// Builds the `syncables` git dependency, which ships as TypeScript source with
// no prebuilt output. npm installs it from GitHub but does not build it, so
// this compiles it once after install. Best-effort: it never fails the install
// (e.g. in CI that only needs source), and it skips work when already built.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..', 'node_modules', 'syncables');
const built = resolve(pkgDir, 'build', 'src', 'index.js');

if (!existsSync(pkgDir)) {
  process.exit(0); // syncables not installed (e.g. --ignore-scripts / offline); nothing to do.
}
if (existsSync(built)) {
  process.exit(0); // already built.
}

try {
  console.log('[reflector] Building syncables dependency…');
  execSync('npm install --no-audit --no-fund --ignore-scripts', {
    cwd: pkgDir,
    stdio: 'inherit',
  });
  execSync('npm run build:release', { cwd: pkgDir, stdio: 'inherit' });
  console.log('[reflector] syncables built.');
} catch (error) {
  console.warn(
    '[reflector] Could not build syncables automatically. Build it manually with:\n' +
      '  cd node_modules/syncables && npm install && npm run build:release\n' +
      `  (${error instanceof Error ? error.message : String(error)})`,
  );
}
