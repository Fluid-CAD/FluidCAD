// Builds a *pre-resolved engine* — a self-contained `node_modules` tree for one
// FluidCAD version × one platform — and packs it as a tarball plus a manifest:
//
//   fluidcad-engine-0.0.41-darwin-arm64.tar.gz
//   └── node_modules/
//       ├── fluidcad/          ← lib/dist, server/dist, ui/dist, bin, llm-docs
//       └── …                  ← every runtime dep, pruned to this platform
//
// The desktop shell downloads one of these, verifies its sha256 and extracts it
// to `~/.fluidcad/engines/<version>/` — deliberately the same shape as a
// project's own `node_modules`, so `require.resolve` and `import` behave
// identically in both cases (Invariant 1: server and lib always siblings).
//
// Why a tarball and not `npm install` at runtime: Electron bundles Node but not
// the npm CLI, the dependency tree carries platform-specific optional deps, and
// a first-run install failure (offline, proxy, private registry) lands on a CAD
// user as a stack trace. Fetch one file → verify → extract is deterministic.
//
// Cross-platform builds run from one machine: npm's `--os`/`--cpu` flags select
// the right optional binaries, and the prune pass is a belt-and-braces check on
// top of them. So a single Linux CI job produces all four targets.
//
// Usage:
//   tsx scripts/build-engine-tarball.ts                       # host platform
//   tsx scripts/build-engine-tarball.ts --platform darwin-arm64
//   tsx scripts/build-engine-tarball.ts --all
//   tsx scripts/build-engine-tarball.ts --all --out dist-engines
//
// Assumes `npm run build` has already run — it packs this checkout with
// `npm pack`, it does not build it.

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type EngineTarget = {
  /** `process.platform` value. */
  platform: 'darwin' | 'win32' | 'linux';
  /** `process.arch` value. */
  arch: 'arm64' | 'x64';
  /** `<platform>-<arch>`, the key used in filenames and manifests. */
  key: string;
};

function target(platform: EngineTarget['platform'], arch: EngineTarget['arch']): EngineTarget {
  return { platform, arch, key: `${platform}-${arch}` };
}

export const ENGINE_TARGETS: EngineTarget[] = [
  target('darwin', 'arm64'),
  target('win32', 'x64'),
  target('linux', 'x64'),
];

export type EngineManifest = {
  schemaVersion: 1;
  version: string;
  target: string;
  platform: string;
  arch: string;
  /** Tarball filename, relative to wherever the manifest is published. */
  file: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  /** Recorded because the wasm kernel moves far slower than the engine does. */
  ocjsVersion: string | null;
  builtAt: string;
};

// ---------------------------------------------------------------------------
// Pruning rules
// ---------------------------------------------------------------------------

/**
 * Dependency families that ship one prebuilt binary package per platform.
 * npm's `--os`/`--cpu` should already have picked the right ones; this drops
 * anything that slipped through (and anything a lockfile pinned as non-optional).
 *
 * Names encode the triple: `@esbuild/darwin-arm64`,
 * `@rolldown/binding-linux-x64-gnu`, `lightningcss-win32-x64-msvc`.
 */
const NATIVE_FAMILIES = [
  { scope: '@esbuild', prefix: '' },
  { scope: '@rolldown', prefix: 'binding-' },
  { scope: null, prefix: 'lightningcss-' },
] as const;

/** Third-party files that no runtime needs. `fluidcad`'s own tree is exempt. */
const PRUNE_FILE_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts', '.js.map', '.mjs.map', '.cjs.map'];
const PRUNE_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github']);

/**
 * The MCP server is excluded from the engine (P0-3, option 2): it is launched
 * by an agent host as its own `npx fluidcad mcp` process and reads the global
 * instance registry, so the desktop app never needs it in-process. `bin/
 * commands/mcp.js` imports the entry lazily, so every other CLI command still
 * works.
 *
 * The dependencies go with it — and they are dropped from the *packed
 * package.json*, before `npm install` runs, rather than deleted afterwards.
 * Deleting them afterwards leaves their transitive closure behind (`hono`,
 * `ajv`, `zod-to-json-schema`, …) and, worse, leaves `zod-to-json-schema`
 * pointing at a `zod` that is no longer there.
 */
const EXCLUDED_DEPENDENCIES = ['zod', '@modelcontextprotocol/sdk'];
const EXCLUDED_ENGINE_DIRS = ['mcp'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** `fluidcad-engine-<version>-<target>` — the stem for both output files. */
export function engineArtifactStem(version: string, targetKey: string): string {
  return `fluidcad-engine-${version}-${targetKey}`;
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

/**
 * `npm pack` the checkout, then repack it without the MCP server. Everything
 * the engine ships is decided by `package.json#files`, so packing (rather than
 * copying by hand) keeps the tarball and the published npm package the same
 * artifact by construction — the engine is that package minus MCP, not a fork.
 */
function packRepo(outDir: string, version: string): string {
  const required = ['lib/dist/index.js', 'server/dist/index.js', 'ui/dist/index.html'];
  const missing = required.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
  if (missing.length > 0) {
    throw new Error(
      `This checkout is not built — missing ${missing.join(', ')}. Run \`npm run build\` first.`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', outDir], REPO_ROOT);
  const packed = path.join(outDir, `fluidcad-${version}.tgz`);
  if (!fs.existsSync(packed)) {
    throw new Error(`npm pack did not produce ${packed}`);
  }

  // `npm pack` always writes `package/` as the tarball root.
  const extracted = path.join(outDir, 'package');
  fs.rmSync(extracted, { recursive: true, force: true });
  execFileSync('tar', ['xzf', packed], { cwd: outDir, stdio: 'inherit' });

  for (const rel of EXCLUDED_ENGINE_DIRS) {
    fs.rmSync(path.join(extracted, rel), { recursive: true, force: true });
  }
  const pkgPath = path.join(extracted, 'package.json');
  const pkg = readJson(pkgPath);
  for (const name of EXCLUDED_DEPENDENCIES) {
    delete pkg.dependencies?.[name];
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const engineDir = path.join(outDir, 'engine');
  fs.rmSync(engineDir, { recursive: true, force: true });
  fs.mkdirSync(engineDir, { recursive: true });
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', engineDir, extracted], outDir);
  const engineTgz = path.join(engineDir, `fluidcad-${version}.tgz`);
  if (!fs.existsSync(engineTgz)) {
    throw new Error(`Repacking the MCP-less engine did not produce ${engineTgz}`);
  }
  return engineTgz;
}

/**
 * Install the packed engine and its production dependencies into a clean
 * staging root, resolving optional binaries for `target` rather than for the
 * machine running this script.
 */
function installStaging(stagingDir: string, packedTgz: string, engineTarget: EngineTarget): void {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  fs.writeFileSync(
    path.join(stagingDir, 'package.json'),
    JSON.stringify(
      {
        name: 'fluidcad-engine-staging',
        version: '0.0.0',
        private: true,
        // The staging root is not the engine; it only exists to give npm
        // something to install *into*. The tarball ships `node_modules` alone.
        dependencies: { fluidcad: `file:${packedTgz}` },
      },
      null,
      2,
    ) + '\n',
  );

  run(
    'npm',
    [
      'install',
      '--omit=dev',
      // Prebuilt binaries for another platform must not run their install
      // scripts here (and would fail if they tried).
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--install-links=false',
      `--os=${engineTarget.platform}`,
      `--cpu=${engineTarget.arch}`,
    ],
    stagingDir,
  );
}

/** Every `node_modules/<name>` and `node_modules/<scope>/<name>` under `root`. */
function listInstalledPackages(nodeModules: string): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') { continue; }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) { continue; }
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModules, entry.name);
      for (const child of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!child.isDirectory() && !child.isSymbolicLink()) { continue; }
        found.push({ name: `${entry.name}/${child.name}`, dir: path.join(scopeDir, child.name) });
      }
    } else {
      found.push({ name: entry.name, dir: path.join(nodeModules, entry.name) });
    }
  }
  return found;
}

/** True when a native-binary package name belongs to a platform we are not building. */
function isForeignNativePackage(name: string, engineTarget: EngineTarget): boolean {
  for (const family of NATIVE_FAMILIES) {
    const scope = family.scope;
    let local: string;
    if (scope) {
      if (!name.startsWith(`${scope}/`)) { continue; }
      local = name.slice(scope.length + 1);
      if (!local.startsWith(family.prefix)) { continue; }
      local = local.slice(family.prefix.length);
    } else {
      if (!name.startsWith(family.prefix)) { continue; }
      local = name.slice(family.prefix.length);
    }
    // `local` is now a triple like `darwin-arm64` or `linux-x64-gnu`. Anything
    // that doesn't lead with our platform-arch pair is another platform's.
    // Keep both libc flavours on Linux — which one loads is a runtime decision.
    if (!/^(darwin|linux|win32|freebsd|android|netbsd|openbsd|sunos)-/.test(local)) {
      return false;
    }
    return !local.startsWith(`${engineTarget.platform}-${engineTarget.arch}`);
  }
  return false;
}

function pruneThirdPartyFiles(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE_DIR_NAMES.has(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      pruneThirdPartyFiles(full);
    } else if (entry.isFile()) {
      if (PRUNE_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        fs.rmSync(full, { force: true });
      }
    }
  }
}

export type PruneReport = {
  removedPackages: string[];
  bytesBefore: number;
  bytesAfter: number;
};

/** Trim the installed tree to what this platform runs. */
export function pruneStaging(nodeModules: string, engineTarget: EngineTarget): PruneReport {
  const bytesBefore = directorySize(nodeModules);
  const removedPackages: string[] = [];

  for (const pkg of listInstalledPackages(nodeModules)) {
    if (isForeignNativePackage(pkg.name, engineTarget)) {
      fs.rmSync(pkg.dir, { recursive: true, force: true });
      removedPackages.push(pkg.name);
      continue;
    }
    // `node_modules/fluidcad` keeps its declarations: P1-4 serves them to
    // Monaco, so the completions describe the engine that is actually running.
    if (pkg.name !== 'fluidcad') {
      pruneThirdPartyFiles(pkg.dir);
    }
  }

  // Empty scope directories left behind by the removals.
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModules, entry.name);
      if (fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    }
  }

  return { removedPackages, bytesBefore, bytesAfter: directorySize(nodeModules) };
}

/** GNU tar can sort and zero timestamps; bsdtar can't, and that's fine. */
function tarSupportsReproducibleFlags(): boolean {
  try {
    return execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('GNU tar');
  } catch {
    return false;
  }
}

function createTarball(stagingDir: string, outFile: string): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });

  const args = ['--create', '--file', outFile];
  if (tarSupportsReproducibleFlags()) {
    // Byte-identical rebuilds of the same input, so a republished engine keeps
    // its sha256 and the shell's cache stays valid.
    args.push('--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner');
    args.push('--use-compress-program', 'gzip -n');
  } else {
    args.push('--gzip');
  }
  args.push('node_modules');

  execFileSync('tar', args, { cwd: stagingDir, stdio: 'inherit' });
}

export type BuildResult = {
  manifest: EngineManifest;
  tarballPath: string;
  manifestPath: string;
  prune: PruneReport;
};

export function buildEngineTarball(options: {
  engineTarget: EngineTarget;
  outDir: string;
  packedTgz: string;
  version: string;
  keepStaging?: boolean;
}): BuildResult {
  const { engineTarget, outDir, packedTgz, version } = options;
  const stem = engineArtifactStem(version, engineTarget.key);
  const stagingDir = path.join(outDir, '.staging', engineTarget.key);

  console.log(`\n▸ ${engineTarget.key}`);
  console.log('  installing production dependencies…');
  installStaging(stagingDir, packedTgz, engineTarget);

  const nodeModules = path.join(stagingDir, 'node_modules');
  console.log('  pruning…');
  const prune = pruneStaging(nodeModules, engineTarget);
  console.log(
    `  pruned ${prune.removedPackages.length} packages: ` +
      `${formatBytes(prune.bytesBefore)} → ${formatBytes(prune.bytesAfter)}`,
  );

  const tarballPath = path.join(outDir, `${stem}.tar.gz`);
  console.log('  packing…');
  createTarball(stagingDir, tarballPath);

  const ocjsPkg = path.join(nodeModules, 'ocjs-fluidcad', 'package.json');
  const manifest: EngineManifest = {
    schemaVersion: 1,
    version,
    target: engineTarget.key,
    platform: engineTarget.platform,
    arch: engineTarget.arch,
    file: path.basename(tarballPath),
    sha256: sha256(tarballPath),
    bytes: fs.statSync(tarballPath).size,
    unpackedBytes: prune.bytesAfter,
    ocjsVersion: fs.existsSync(ocjsPkg) ? (readJson(ocjsPkg).version ?? null) : null,
    builtAt: new Date().toISOString(),
  };

  const manifestPath = path.join(outDir, `${stem}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (!options.keepStaging) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  console.log(
    `  ${manifest.file} — ${formatBytes(manifest.bytes)} compressed, ` +
      `${formatBytes(manifest.unpackedBytes)} on disk`,
  );
  return { manifest, tarballPath, manifestPath, prune };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function hostTarget(): EngineTarget {
  const found = ENGINE_TARGETS.find((t) => t.platform === process.platform && t.arch === process.arch);
  if (!found) {
    throw new Error(`No engine target for this host (${process.platform}-${process.arch}).`);
  }
  return found;
}

function parseArgs(argv: string[]): { targets: EngineTarget[]; outDir: string; keepStaging: boolean } {
  let outDir = path.join(REPO_ROOT, 'dist-engines');
  let keepStaging = false;
  const targets: EngineTarget[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      targets.push(...ENGINE_TARGETS);
    } else if (arg === '--platform' || arg === '--target') {
      const key = argv[i + 1];
      i += 1;
      const found = ENGINE_TARGETS.find((t) => t.key === key);
      if (!found) {
        throw new Error(
          `Unknown target "${key}". Known: ${ENGINE_TARGETS.map((t) => t.key).join(', ')}`,
        );
      }
      targets.push(found);
    } else if (arg === '--out') {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--keep-staging') {
      keepStaging = true;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  const unique = targets.filter((t, index) => targets.indexOf(t) === index);
  return { targets: unique.length > 0 ? unique : [hostTarget()], outDir, keepStaging };
}

async function main(): Promise<void> {
  const { targets, outDir, keepStaging } = parseArgs(process.argv.slice(2));
  const version = readJson(path.join(REPO_ROOT, 'package.json')).version as string;

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Building engine ${version} for ${targets.map((t) => t.key).join(', ')}`);
  console.log(`Output: ${outDir}`);

  const packDir = path.join(outDir, '.pack');
  const packedTgz = packRepo(packDir, version);
  console.log(`Packed ${path.basename(packedTgz)} (${formatBytes(fs.statSync(packedTgz).size)})`);

  const results: BuildResult[] = [];
  for (const engineTarget of targets) {
    results.push(buildEngineTarball({ engineTarget, outDir, packedTgz, version, keepStaging }));
  }

  if (!keepStaging) {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.rmSync(path.join(outDir, '.staging'), { recursive: true, force: true });
  }

  console.log('\nDone:');
  for (const result of results) {
    console.log(
      `  ${result.manifest.target.padEnd(14)} ${formatBytes(result.manifest.bytes).padStart(9)}  ` +
        `${result.manifest.sha256.slice(0, 12)}…`,
    );
  }
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.stack ?? err?.message ?? String(err));
    process.exit(1);
  });
}
