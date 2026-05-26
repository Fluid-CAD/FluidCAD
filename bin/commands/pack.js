import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPackageVersion() {
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function findEntry(workspace, override) {
  if (override) {
    const abs = resolve(workspace, override);
    if (!existsSync(abs)) {
      throw new Error(`Entry file not found: ${abs}`);
    }
    return abs;
  }
  const candidates = readdirSync(workspace).filter((f) => f.endsWith('.fluid.js'));
  if (candidates.length === 0) {
    throw new Error('No .fluid.js files found in the workspace. Pass --entry to specify one.');
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple .fluid.js files found: ${candidates.join(', ')}. Pass --entry to choose one.`,
    );
  }
  return resolve(workspace, candidates[0]);
}

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
  console.log(
    `Wrote ${outPath} (${zip.length} bytes, ${manifest.assets.length} asset${manifest.assets.length === 1 ? '' : 's'})`,
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
