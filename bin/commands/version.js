import { resolve } from 'path';

/**
 * `fluidcad version <major|minor|patch|x.y.z>`: bump the workspace
 * package's `package.version`. Packing never bumps; releasing a new version
 * is this, then `fluidcad pack`.
 */
async function runVersion(spec, opts) {
  const { PackageAuthoring, PackageAuthoringError } = await import('../../server/dist/packages/package-authoring.js');

  const workspace = resolve(opts.workspace ?? process.cwd());
  try {
    const change = PackageAuthoring.bumpVersion(workspace, spec);
    console.log(`${change.name} ${change.from} → ${change.to}`);
  } catch (err) {
    if (err instanceof PackageAuthoringError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export function registerVersionCommand(program) {
  program
    .command('version')
    .description("Bump this package's version in fluidcad.json")
    .argument('<bump>', 'major, minor or patch, or an exact version such as 1.2.0')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .action((spec, opts) => {
      runVersion(spec, opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
