import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { confirm, isInteractive } from '../lib/prompt.js';
import { readPackageVersion } from '../lib/workspace.js';
import { describeTarget, exitOnRefusal, loadPackages, printConsentSummary } from '../lib/packages.js';

/**
 * `fluidcad install`, the one package verb (research §3):
 * - `install <file.fluidpkg> [--library|--project] [--yes]` installs from a
 *   file, after the consent summary, and pins it when run in a project;
 * - `install <@scope/name>[@version] [--project]` pins a package already
 *   installed into this project, and with `--project` copies it in too;
 * - `install` alone lists the packages this project pins but has in neither
 *   root, and exits 1 when there are any. Fetching them from the hub comes
 *   with the hub.
 */
async function runInstall(arg, opts) {
  const mods = await loadPackages();
  const cwd = process.cwd();
  const project = mods.PackagePins.isProject(cwd) ? cwd : null;
  if (opts.library && opts.project) {
    fail('Pass --library or --project, not both.');
  }
  // What an install killed mid-way left behind (its process is gone).
  mods.PackageInstaller.sweep(project);

  try {
    if (!arg) {
      runMissing(mods, project);
    } else if (isFile(arg)) {
      await installFile(mods, resolve(arg), project, opts);
    } else {
      await installName(mods, arg, project, opts);
    }
  } catch (err) {
    exitOnRefusal(err, mods);
  }
}

async function installFile(mods, file, project, opts) {
  if (opts.project && !project) {
    fail('--project installs into a project, and this directory is not one (no fluidcad.json or init.js).');
  }
  if (!existsSync(file)) {
    fail(`${file} doesn't exist.`);
  }
  const target = opts.project ? 'project' : opts.library ? 'library' : await preferredTarget(mods, project);
  const inspection = await mods.PackageArchive.inspect(readFileSync(file), {
    root: mods.PackageRoots.rootFor(target, project),
    engineVersion: readPackageVersion(),
  });
  const { name, version } = inspection.manifest;
  try {
    // A pin that would change refuses before anything is asked or written.
    if (project) {
      mods.PackagePins.check(project, name, version, inspection.integrity);
    }
    printConsentSummary(inspection);
    console.log(`Installing into ${describeTarget(mods, target, mods.PackageRoots.rootFor(target, project))}${project ? ', and pinning it in this project' : ''}.`);
    if (!opts.yes && !(await consented())) {
      mods.PackageArchive.discard(inspection.token);
      console.error('Nothing was installed.');
      process.exit(1);
    }
  } catch (err) {
    mods.PackageArchive.discard(inspection.token);
    throw err;
  }

  const outcome = await mods.ProjectPackages.installInspected({
    token: inspection.token,
    target,
    project,
    pin: project !== null,
    replace: opts.replace === true,
  });
  console.log(installedLine(mods, outcome));
  printPin(outcome.pin, name, version);
}

async function installName(mods, spec, project, opts) {
  if (!project) {
    fail(`Run \`fluidcad install ${spec}\` in a project: it pins the package there. To install a package into your library, pass its .fluidpkg file.`);
  }
  if (opts.library) {
    fail(`${spec} is already installed or it isn't: --library is for installing a .fluidpkg file.`);
  }
  const outcome = await mods.ProjectPackages.useInstalled(spec, project, { copy: opts.project === true });
  const { name, version } = outcome.location;
  if (outcome.copied) {
    console.log(installedLine(mods, outcome.copied));
  } else if (opts.project) {
    console.log(`${name} ${version} is already in ${describeTarget(mods, 'project', outcome.location.directory)}.`);
  }
  printPin(outcome.pin, name, version, outcome.copied ? null : outcome.location.target);
}

function runMissing(mods, project) {
  if (!project) {
    fail('Run `fluidcad install` in a project: it installs the packages the project pins. To install a package, pass its .fluidpkg file.');
  }
  const pins = mods.PackagePins.availability(project);
  const missing = pins.filter((pin) => pin.availability === 'missing');
  if (pins.length === 0) {
    console.log('This project pins no packages.');
    return;
  }
  if (missing.length === 0) {
    console.log(`Every package this project pins is installed (${pins.length}).`);
    return;
  }
  console.error(`This project pins ${missing.length === 1 ? 'a package that isn\'t' : 'packages that aren\'t'} installed:`);
  for (const pin of missing) {
    console.error(`  ${pin.name} ${pin.version}`);
  }
  console.error('Install each from its file: fluidcad install <file.fluidpkg>. Downloading them from the hub comes later.');
  process.exit(1);
}

/** The "New packages go to" setting; the project only when there is one. */
async function preferredTarget(mods, project) {
  const preferred = (await mods.loadPreferences()).packageInstallTarget;
  return preferred === 'project' && project ? 'project' : 'library';
}

async function consented() {
  if (!isInteractive()) {
    console.error('Pass --yes to install without being asked.');
    return false;
  }
  return confirm('Install it?');
}

function installedLine(mods, result) {
  const where = describeTarget(mods, result.target, result.directory);
  switch (result.status) {
    case 'unchanged':
      return `${result.name} ${result.version} is already in ${where}, with the same contents: nothing changed.`;
    case 'replaced':
      return `Replaced ${result.name} ${result.version} in ${where}.`;
    default:
      return `Installed ${result.name} ${result.version} into ${where}.`;
  }
}

function printPin(pin, name, version, from = null) {
  if (pin === 'pinned') {
    console.log(`Pinned ${name} ${version} in this project's fluidcad.json${from === 'library' ? ' (it loads from your library)' : ''}.`);
  } else if (pin === 'unchanged') {
    console.log(`This project already pins ${name} ${version}.`);
  }
}

/** A `.fluidpkg`, or any existing path that isn't a package name. */
function isFile(arg) {
  return arg.endsWith('.fluidpkg') || (!arg.startsWith('@') && existsSync(resolve(arg)));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

export function registerInstallCommand(program) {
  program
    .command('install [package]')
    .description('Install a package from a .fluidpkg file, pin an installed one into this project, or (no arguments) list the pinned packages that are missing')
    .option('--library', 'Install the file into your package library (the default, unless Settings say otherwise)')
    .option('--project', "Install into this project's packages/ folder; with a package name, copy it there from your library")
    .option('-y, --yes', 'Install without asking')
    .option('--replace', 'Replace an installed copy of the same version whose contents differ')
    .action((arg, opts) => {
      runInstall(arg, opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
