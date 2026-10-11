import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { readPackageVersion } from '../lib/workspace.js';
import { HubInstallCli } from '../lib/hub-install.js';
import { consented, describeTarget, exitOnRefusal, installedLine, preferredTarget, printConsentSummary, printPin } from '../lib/packages.js';

/**
 * `fluidcad install`, the one package verb (research §3, hub-plan H8):
 * - `install <file.fluidpkg> [--library|--project] [--yes]` installs from a
 *   file, after the consent summary, and pins it when run in a project;
 * - `install <@scope/name>[@version] [--library|--project] [--hub <url>]`:
 *   an exact version (or the one this project pins) is taken from what is
 *   installed when it can be, else from the hub; a name alone asks the hub
 *   for its latest version first, and uses an installed copy of that
 *   version when it has the hub's contents (the newest installed one when
 *   the hub can't be reached). An installed copy is pinned into this
 *   project (and with `--project` copied in); a download is verified,
 *   shown in the consent summary, installed, and pinned in a project;
 * - `install` alone downloads every package this project pins but has in
 *   neither root, each checked against its pin, after one consent summary;
 *   it exits 1 when any failed.
 */
async function runInstall(arg, opts) {
  const mods = await HubInstallCli.load();
  const cwd = process.cwd();
  const project = mods.PackagePins.isProject(cwd) ? cwd : null;
  if (opts.library && opts.project) {
    fail('Pass --library or --project, not both.');
  }
  // What an install killed mid-way left behind (its process is gone).
  mods.PackageInstaller.sweep(project);

  try {
    if (!arg) {
      await runMissing(mods, project, opts);
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
  const target = await targetOf(mods, project, opts);
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

/**
 * Where the package comes from is `HubInstaller.choose`'s rule: an exact
 * (or pinned) version from what is installed, else the hub; a name alone
 * asks the hub first, with the newest installed version when the hub
 * can't be reached.
 */
async function installName(mods, spec, project, opts) {
  const parsed = mods.ProjectPackages.parseSpec(spec);
  if (opts.project && !project) {
    fail('--project installs into a project, and this directory is not one (no fluidcad.json or init.js).');
  }
  const target = await targetOf(mods, project, opts);
  await new HubInstallCli(mods, opts).installName(parsed, project, target);
}

async function runMissing(mods, project, opts) {
  if (!project) {
    fail('Run `fluidcad install` in a project: it installs the packages the project pins. To install a package, pass its name or its .fluidpkg file.');
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
  await new HubInstallCli(mods, opts).installMissing(missing, project, await targetOf(mods, project, opts));
}

/** `--project` or `--library`, else the "New packages go to" setting. */
async function targetOf(mods, project, opts) {
  return opts.project ? 'project' : opts.library ? 'library' : preferredTarget(mods, project);
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
    .description('Install a package by name (a name alone: the hub\'s latest; name@version: your library, else the hub) or from a .fluidpkg file; with no arguments, download every package this project pins that is missing')
    .option('--library', 'Install into your package library (the default, unless Settings say otherwise)')
    .option('--project', "Install into this project's packages/ folder; with a package name in your library, copy it there")
    .option('-y, --yes', 'Install without asking')
    .option('--replace', 'Replace an installed copy of the same version whose contents differ')
    .option('--hub <url>', 'The hub to download from (default: FLUIDCAD_HUB_URL, else https://hub.fluidcad.io)')
    .action((arg, opts) => {
      runInstall(arg, opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
