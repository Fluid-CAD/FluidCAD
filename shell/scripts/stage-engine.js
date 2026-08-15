// Stages the built-in engine into `shell/resources/engine/`, which
// electron-builder copies into the app bundle as `resources/engine/`.
//
// The built-in engine is *the same artifact* the shell would download for a
// pinned project — the tarball built by `npm run build:engine` — just extracted
// ahead of time. That is what makes "ships with the app" and "downloaded later"
// one code path in the resolver (P2-2).
//
// It is extracted, never left as an archive and never put inside `app.asar`:
// the engine runs a live Vite server and loads native binaries and wasm, all of
// which need real file paths.
//
// Usage:  node scripts/stage-engine.js [--target linux-x64] [--force]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tar = require('tar');

const SHELL_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SHELL_DIR, '..');
const ENGINES_DIR = path.join(REPO_ROOT, 'dist-engines');
// `shell/engine/` and not `shell/resources/engine/`: electron-builder copies
// `engine/**/*` into the bundle's `resources/engine/`, which is where
// `builtinEngineRoot()` looks (`process.resourcesPath/engine`).
const DESTINATION = path.join(SHELL_DIR, 'engine');

function parseArgs(argv) {
  let target = `${process.platform}-${process.arch}`;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target' || argv[i] === '--platform') {
      target = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--force') {
      force = true;
    }
  }
  return { target, force };
}

/** Newest file mtime under `dir`, recursively. */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.isFile()) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * True when the tarball is older than the build it was made from.
 *
 * The version rarely changes while developing, so "a tarball for this version
 * exists" is not the same question as "it contains the code I just built" —
 * without this, an engine fix lands in `server/dist` and the app keeps running
 * the previous one, with nothing to suggest why.
 *
 * The whole dist trees are walked, not just their entry files: `tsc` is
 * incremental and rewrites only the outputs whose sources changed, so an edit
 * to `server/src/host/…` never touches `server/dist/index.js` at all.
 */
function isStale(tarball) {
  let builtAt;
  try {
    builtAt = fs.statSync(tarball).mtimeMs;
  } catch {
    return true;
  }
  return ['lib/dist', 'server/dist', 'server/vendor', 'ui/dist', 'bin', 'llm-docs'].some(
    (rel) => newestMtime(path.join(REPO_ROOT, rel)) > builtAt,
  );
}

function main() {
  const { target, force } = parseArgs(process.argv.slice(2));
  const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const tarball = path.join(ENGINES_DIR, `fluidcad-engine-${version}-${target}.tar.gz`);

  if (force || isStale(tarball)) {
    console.log(`Building engine ${version} for ${target}…`);
    execFileSync(
      'npx',
      ['tsx', 'scripts/build-engine-tarball.ts', '--platform', target, '--out', ENGINES_DIR],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
  }
  if (!fs.existsSync(tarball)) {
    throw new Error(`No engine tarball at ${tarball}.`);
  }

  fs.rmSync(DESTINATION, { recursive: true, force: true });
  fs.mkdirSync(DESTINATION, { recursive: true });
  tar.x({ file: tarball, cwd: DESTINATION, sync: true });

  const serverEntry = path.join(DESTINATION, 'node_modules', 'fluidcad', 'server', 'dist', 'index.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`The staged engine has no server at ${serverEntry}.`);
  }
  console.log(`Staged engine ${version} (${target}) → ${DESTINATION}`);
}

main();
