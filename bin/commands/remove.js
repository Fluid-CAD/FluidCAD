import { describeTarget, exitOnRefusal, loadPackages } from '../lib/packages.js';

/**
 * `fluidcad remove <@scope/name>[@version] [--library|--project]`: take an
 * installed package out of your library (the default) or out of this
 * project's packages/ folder. The version goes in the name, as `install`
 * takes it (a `--version` flag would be the CLI's own); it may be left out
 * when only one is installed. A project that still pins the removed version
 * will ask for it again; its pin is left alone.
 */
async function runRemove(spec, opts) {
  const mods = await loadPackages();
  const cwd = process.cwd();
  const project = mods.PackagePins.isProject(cwd) ? cwd : null;
  if (opts.library && opts.project) {
    fail('Pass --library or --project, not both.');
  }
  if (opts.project && !project) {
    fail("--project removes from this project's packages/ folder, and this directory is not a project (no fluidcad.json or init.js).");
  }
  const target = opts.project ? 'project' : 'library';
  try {
    const parsed = mods.ProjectPackages.parseSpec(spec);
    const { removed, strandedPin } = mods.ProjectPackages.remove(parsed.name, parsed.version, target, project);
    console.log(`Removed ${removed.name} ${removed.version} from ${describeTarget(mods, target, removed.root)}.`);
    if (strandedPin) {
      console.log(
        `This project still pins ${strandedPin.name} ${strandedPin.version}, which is no longer installed: ` +
          'its models will ask for it until you install it again (fluidcad install <file.fluidpkg>).',
      );
    }
  } catch (err) {
    exitOnRefusal(err, mods);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

export function registerRemoveCommand(program) {
  program
    .command('remove <package>')
    .description('Remove an installed package (@scope/name, or @scope/name@version when several are installed) from your library or from this project')
    .option('--library', 'Remove it from your package library (the default)')
    .option('--project', "Remove it from this project's packages/ folder")
    .action((spec, opts) => {
      runRemove(spec, opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
