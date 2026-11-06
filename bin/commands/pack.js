import { existsSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { readPackageVersion } from '../lib/workspace.js';

/**
 * `fluidcad pack`: pack the workspace's package (the "package" block of its
 * fluidcad.json, exports from its features/, parts/ and assemblies/
 * folders) into `<scope>-<name>-<version>.fluidpkg`
 * (`@acme/feature-tests` 0.1.0 → `acme-feature-tests-0.1.0.fluidpkg`), to
 * look at what would be published without publishing. It is never a step
 * before publishing: `fluidcad publish` packs the workspace itself, through
 * the same builder, and uploads that. Packages install only from the hub
 * (HD31), so nothing installs this file either. The rules and the checks
 * live in the server's `PackageBuilder`; this is the terminal around it.
 * Nothing in the workspace is written but the archive.
 *
 * `--json` prints one JSON object instead of the summary: the archive's
 * identity and path, its contents by folder and its doc pages
 * (`PackageLayout.contentsOf`, what the MCP `pack` tool returns as
 * `contents`), and the pack's `warnings`. A refusal prints
 * `{ "error", "code" }` and exits 1.
 *
 * Warnings — fields without a description, doc links that lead nowhere —
 * are printed under the summary. They never stop the pack or change the
 * exit code.
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

  const { manifest, zip, warnings } = result;
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
      warnings,
    }, null, 2));
    return;
  }
  printSummary(manifest, contents, outPath, zip.length);
  printWarnings(warnings);
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
  if (contents.docs.length > 0) {
    rows.push(['docs/', count(contents.docs.length, 'page'), contents.docs.map((page) => page.slice('docs/'.length))]);
  }
  for (const [folder, counted, names] of rows) {
    console.log(`  ${folder.padEnd(12)}${counted}${names.length ? `: ${names.join(', ')}` : ''}`);
  }
  if (contents.models === 0) {
    console.log('  no parts or assemblies: the hub needs at least one to publish');
  }
  // The archive holds manifest.json beside the files it lists.
  console.log(`  ${count(manifest.files.length + 1, 'file')}, ${size(bytes)}, unit ${manifest.unit}`);
}

/** The warnings under the summary: how many, then one per line. Nothing when there are none. */
function printWarnings(warnings) {
  if (warnings.length === 0) {
    return;
  }
  console.log('');
  console.log(`${count(warnings.length, 'warning')} (the package still packed):`);
  for (const warning of warnings) {
    console.log(`  ! ${warning.message}`);
  }
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
    .description('Pack this package workspace (its features/, parts/ and assemblies/) into a .fluidpkg archive to look at, without publishing (`fluidcad publish` packs on its own)')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-o, --out <path>', 'Output file, or a directory to write it into (defaults to <scope>-<name>-<version>.fluidpkg in the workspace)')
    .option('--json', 'Print the result as JSON: the archive and its features, parts and assemblies by folder')
    .action((opts) => {
      runPack(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
