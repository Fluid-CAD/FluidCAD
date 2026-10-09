import { existsSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { readPackageVersion } from '../lib/workspace.js';

/**
 * `fluidcad pack`: pack the workspace's package (the "package" block of its
 * fluidcad.json) into `<scope>-<name>-<version>.fluidpkg`. The rules and the
 * checks live in the server's `PackageBuilder`; this is the terminal around
 * it. Nothing in the workspace is written but the archive.
 */
async function runPack(opts) {
  // Imported lazily: the packer boots the engine (Vite + OC wasm), which the
  // rest of the CLI doesn't need at startup.
  const { packPackage, PackageBuildError } = await import('../../server/dist/packages/package-builder.js');
  const { PackageLayout } = await import('../../server/dist/packages/package-manifest.js');

  const workspace = resolve(opts.workspace ?? process.cwd());
  let result;
  try {
    // The engine narrates every scene it starts; the summary below is the
    // command's output. Warnings and errors still reach the terminal.
    result = await quietly(() => packPackage({ workspacePath: workspace, fluidcadVersion: readPackageVersion() }));
  } catch (err) {
    if (err instanceof PackageBuildError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const { manifest, zip } = result;
  const archiveName = PackageLayout.archiveName(manifest.name, manifest.version);
  const outPath = outputPath(opts.out, workspace, archiveName);
  writeFileSync(outPath, zip);
  printSummary(manifest, outPath, zip.length);
}

/** `-o` names the archive, or a directory to write it into; the workspace root by default. */
function outputPath(out, workspace, archiveName) {
  if (!out) {
    return join(workspace, archiveName);
  }
  const target = resolve(out);
  if (existsSync(target) && statSync(target).isDirectory()) {
    return join(target, archiveName);
  }
  return target;
}

async function quietly(fn) {
  const { log, info, debug } = console;
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.info = info;
    console.debug = debug;
  }
}

function printSummary(manifest, outPath, bytes) {
  console.log(`Packed ${manifest.name} ${manifest.version} → ${outPath}`);
  const features = manifest.features.map((f) => f.id);
  const parts = manifest.parts.map((p) => (p.kind === 'assembly' ? `${p.exportName} (assembly)` : p.exportName));
  console.log(`  ${count(features.length, 'feature')}${features.length ? `: ${features.join(', ')}` : ''}`);
  console.log(`  ${count(parts.length, 'part')}${parts.length ? `: ${parts.join(', ')}` : ''}`);
  const raw = manifest.features.filter((f) => f.usesOcct).map((f) => f.id);
  if (raw.length > 0) {
    console.log(`  raw OpenCascade: ${raw.join(', ')} (installers warn about it)`);
  }
  // The archive holds manifest.json beside the files it lists.
  console.log(`  ${count(manifest.files.length + 1, 'file')}, ${size(bytes)}, unit ${manifest.unit}`);
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function size(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerPackCommand(program) {
  program
    .command('pack')
    .description('Pack this package workspace into a .fluidpkg archive others can install')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-o, --out <path>', 'Output file, or a directory to write it into (defaults to <scope>-<name>-<version>.fluidpkg in the workspace)')
    .action((opts) => {
      runPack(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
