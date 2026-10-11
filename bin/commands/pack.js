import { existsSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { readPackageVersion } from '../lib/workspace.js';

/**
 * `fluidcad pack`: pack the workspace's package (the "package" block of its
 * fluidcad.json, exports from its features/, parts/ and assemblies/
 * folders) into `<name>-<version>.fluidpkg`, under the author's bare name
 * (`feature-tests-0.1.0.fluidpkg`: the hub adds the publisher's handle when
 * it is published). The rules and the
 * checks live in the server's `PackageBuilder`; this is the terminal around
 * it. Nothing in the workspace is written but the archive.
 *
 * `--json` prints one JSON object instead of the summary: the archive's
 * identity and path, and its contents by folder (`PackageLayout.contentsOf`,
 * what the MCP `pack` tool returns as `contents`). A refusal prints
 * `{ "error", "code" }` and exits 1.
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
      if (opts.json) {
        console.log(JSON.stringify({ error: err.message, code: err.code }, null, 2));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
    throw err;
  }

  const { manifest, zip } = result;
  const archiveName = PackageLayout.archiveName(manifest.name, manifest.version);
  const outPath = outputPath(opts.out, workspace, archiveName);
  writeFileSync(outPath, zip);
  const contents = PackageLayout.contentsOf(manifest);
  if (opts.json) {
    console.log(JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      fileName: archiveName,
      savedTo: outPath,
      bytes: zip.length,
      // The archive holds manifest.json beside the files it lists.
      files: manifest.files.length + 1,
      unit: manifest.unit,
      contents,
    }, null, 2));
    return;
  }
  printSummary(manifest, contents, outPath, zip.length);
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

/** The summary, folder by folder: the feature ids, then the parts and assemblies by export name. */
function printSummary(manifest, contents, outPath, bytes) {
  console.log(`Packed ${manifest.name} ${manifest.version} → ${outPath}`);
  const rows = [
    ['features/', count(contents.features.length, 'feature'), contents.features.map((f) => f.id)],
    ['parts/', count(contents.parts.length, 'part'), contents.parts.map((p) => p.exportName)],
    ['assemblies/', count(contents.assemblies.length, 'assembly', 'assemblies'), contents.assemblies.map((a) => a.exportName)],
  ];
  for (const [folder, counted, names] of rows) {
    console.log(`  ${folder.padEnd(12)}${counted}${names.length ? `: ${names.join(', ')}` : ''}`);
  }
  if (contents.models === 0) {
    console.log('  no parts or assemblies: it installs, but the hub needs at least one to publish');
  }
  // The archive holds manifest.json beside the files it lists.
  console.log(`  ${count(manifest.files.length + 1, 'file')}, ${size(bytes)}, unit ${manifest.unit}`);
}

function count(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
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
    .description('Pack this package workspace (its features/, parts/ and assemblies/) into a .fluidpkg archive others can install')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-o, --out <path>', 'Output file, or a directory to write it into (defaults to <name>-<version>.fluidpkg in the workspace)')
    .option('--json', 'Print the result as JSON: the archive and its features, parts and assemblies by folder')
    .action((opts) => {
      runPack(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
