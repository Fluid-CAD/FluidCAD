import { parseProjectUnit, LENGTH_UNITS } from '../../server/dist/project-config.js';
import { preferredNewProjectUnit } from '../../server/dist/preferences.js';
import { ProjectScaffold, ProjectScaffoldError } from '../../server/dist/project-scaffold.js';
import { HubCli } from '../lib/hub.js';
import { readPackageVersion } from '../lib/workspace.js';

/**
 * `fluidcad init`: scaffold a project in the current directory, or with
 * `--package @handle/name` a package workspace (ui-packages-plan U3). The
 * files live in the server's `ProjectScaffold` and `PackageScaffold`; this
 * is the terminal around them.
 */
async function runInit(options) {
  const cwd = process.cwd();

  // Validate before touching the disk: a bad unit must not leave a
  // half-scaffolded project behind.
  const explicitUnit = options.unit === undefined ? null : parseProjectUnit(options.unit);
  if (options.unit !== undefined && explicitUnit === null) {
    console.error(`Unknown length unit '${options.unit}'. Use one of: ${LENGTH_UNITS.join(', ')}.`);
    process.exit(1);
  }
  // No `--unit`: the Settings dialog's "default unit for new projects"
  // decides, and it stays null for mm so an untouched preference scaffolds
  // exactly what it always has.
  const unit = explicitUnit ?? (await preferredNewProjectUnit());
  const scaffold = { unit, engineVersion: readPackageVersion() };

  if (options.package !== undefined) {
    await initPackage(cwd, options.package, scaffold);
    return;
  }

  try {
    ProjectScaffold.write(cwd, scaffold);
  } catch (err) {
    exitOnRefusal(err, [ProjectScaffoldError]);
  }
  console.log('FluidCAD initialized.');
}

/**
 * `--package`: the name as `package init` takes it (HD30) — `@acme/kit` as
 * typed; a bare `kit` under the handle this machine is signed in to the hub
 * as, said so; signed out, refused with the sentence saying to add the
 * scope — then the layout, printed as it was written.
 */
async function initPackage(cwd, asked, scaffold) {
  // Imported lazily, like `package init`: a plain init needs none of it.
  const { PackageAuthoring, PackageAuthoringError } = await import('../../server/dist/packages/package-authoring.js');
  const { PackageScaffold } = await import('../../server/dist/packages/package-scaffold.js');
  const { PackageName } = await import('../../server/dist/packages/package-name.js');

  try {
    // The handle is only looked up for a name without its scope.
    const signedIn = PackageName.isValid(asked) ? null : await HubCli.signedInHandle({});
    const name = PackageAuthoring.scopedName(asked, signedIn?.handle ?? null);
    const written = PackageScaffold.write(cwd, { ...scaffold, name });
    if (name !== asked) {
      console.log(`Named it ${name}: your handle on ${signedIn.origin}.`);
    }
    console.log(`FluidCAD package ${name} ${PackageScaffold.INITIAL_VERSION} initialized:`);
    for (const rel of written) {
      console.log(`  ${rel}`);
    }
    console.log(
      'Put the package\'s feature modules in features/, its parts in parts/ and its assemblies in assemblies/: ' +
        'the package exports what those folders hold.',
    );
  } catch (err) {
    exitOnRefusal(err, [ProjectScaffoldError, PackageAuthoringError]);
  }
}

/** A refusal is printed and exits 1; anything else is a bug and keeps its stack. */
function exitOnRefusal(err, refusals) {
  if (refusals.some((type) => err instanceof type)) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Scaffold init.js, an empty part1.part.js, jsconfig.json, and fluidcad.json in the current directory, and keep .fluidcad/ out of git (.gitignore)')
    .option('--unit <unit>', `project document unit written to fluidcad.json: ${LENGTH_UNITS.join(', ')} (default: the Settings dialog's unit for new projects, mm unless changed)`)
    .option('--package <@handle/name>', 'scaffold a package workspace instead (an empty directory): the part in parts/, features/ and assemblies/, a README, and the "package" block at version 1.0.0; signed in to the hub, a name without the scope takes your handle')
    .action(runInit);
}
