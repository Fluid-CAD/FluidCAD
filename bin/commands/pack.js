import { writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import { findEntry, readPackageVersion } from '../lib/workspace.js';

async function runPack(opts) {
  // The packer lives in server/ because esbuild + jszip belong at that layer;
  // import it lazily so the rest of the CLI doesn't pay the cost.
  const { packModel } = await import('../../server/dist/model-package/pack.js');

  const workspace = resolve(opts.workspace ?? process.cwd());
  const entry = findEntry(workspace, opts.entry);
  const fluidcadVersion = readPackageVersion();

  const { manifest, zip } = await packModel({
    entryPath: entry,
    workspacePath: workspace,
    fluidcadVersion,
    name: opts.name,
    description: opts.description,
  });

  const outPath = opts.out
    ? resolve(opts.out)
    : resolve(workspace, basename(entry).replace(/\.fluid\.js$/i, '') + '.fluidpkg');
  writeFileSync(outPath, zip);
  const fileCount = manifest.files?.length ?? 0;
  const assetCount = manifest.assets.length;
  console.log(
    `Wrote ${outPath} (${zip.length} bytes, ${fileCount} file${fileCount === 1 ? '' : 's'}, ` +
      `${assetCount} asset${assetCount === 1 ? '' : 's'})`,
  );
}

export function registerPackCommand(program) {
  program
    .command('pack')
    .description('Package a .fluid.js model into a shareable .fluidpkg archive')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-e, --entry <file>', 'Entry .fluid.js file (auto-detected if only one exists)')
    .option('-o, --out <path>', 'Output path (defaults to <entry-basename>.fluidpkg in the workspace)')
    .option('-n, --name <name>', 'Package name (defaults to the entry file basename)')
    .option('-d, --description <text>', 'Optional human description')
    .action((opts) => {
      runPack(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
