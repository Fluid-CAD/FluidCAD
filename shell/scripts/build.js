// Builds the shell: `src/main.ts` and `src/preload.ts`, each bundled into one
// CommonJS file in `dist/`. Type checking is `tsc --noEmit`, run first by
// `npm run build`.
//
// Bundled rather than compiled file by file because most of what the shell
// runs is shared with `npx fluidcad`: the start screen's data, the engine
// cache and resolver, project sessions and previews all live in
// `../launcher/src`, outside this package, and only a bundler can take them
// in without dragging the repo's layout into `dist/`.
//
// Electron and the shell's runtime dependencies stay external: electron-builder
// packs `node_modules` into the app, and `electron-updater` loads parts of
// itself lazily, which a bundle would break.

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const SHELL_DIR = path.resolve(__dirname, '..');
const pkg = require(path.join(SHELL_DIR, 'package.json'));

async function main() {
  fs.rmSync(path.join(SHELL_DIR, 'dist'), { recursive: true, force: true });
  await esbuild.build({
    absWorkingDir: SHELL_DIR,
    entryPoints: ['src/main.ts', 'src/preload.ts'],
    outdir: 'dist',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: true,
    external: ['electron', ...Object.keys(pkg.dependencies ?? {})],
    logLevel: 'warning',
  });
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
