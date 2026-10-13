import { Option } from 'commander';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { HubInstallCli } from '../lib/hub-install.js';
import { exitOnRefusal, preferredTarget } from '../lib/packages.js';

/**
 * `fluidcad install`, the one package verb (research §3, hub-plan H8).
 * Packages install only from the hub (HD31): a `.fluidpkg` file, or any
 * other path, is refused before anything is read.
 * - `install <@scope/name>[@version] [--library|--project] [--hub <url>]`:
 *   an exact version (or the one this project pins) is taken from what is
 *   installed when it can be, else from the hub; a name alone asks the hub
 *   for its latest version first, and uses an installed copy of that
 *   version when it has the hub's contents (the newest installed one when
 *   the hub can't be reached). An installed copy is pinned into this
 *   project (and with `--project` copied in); a download is verified,
 *   installed, and pinned in a project;
 * - `install` alone downloads every package this project pins but has in
 *   neither root, each checked against its pin; it exits 1 when any failed.
 * Nothing asks first (the user, 2026-10-13): `-y`/`--yes` is still accepted,
 * and does nothing, so scripts written for the question keep working.
 */
async function runInstall(arg, opts) {
  const mods = await HubInstallCli.load();
  if (arg && isFile(arg)) {
    // Before the sweep: a refused file touches neither root.
    fail(mods.HubInstallMessages.NO_FILE_INSTALLS);
  }
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
    } else {
      await installName(mods, arg, project, opts);
    }
  } catch (err) {
    exitOnRefusal(err, mods);
  }
}

/**
 * Where the package comes from is `HubInstaller.choose`'s rule: an exact
 * (or pinned) version from what is installed, else the hub; a name alone
 * asks the hub first, with the newest installed version when the hub
 * can't be reached.
 */
async function installName(mods, spec, project, opts) {
  // A bare name (feature-tests): two publishers can each have one, so the
  // hub needs the handle.
  const at = spec.lastIndexOf('@');
  const bare = at > 0 ? spec.slice(0, at) : spec;
  if (!spec.startsWith('@') && mods.PackageName.isBare(bare)) {
    throw mods.HubInstaller.noPublisherRefusal(bare);
  }
  const parsed = mods.ProjectPackages.parseSpec(spec);
  if (opts.project && !project) {
    fail('--project installs into a project, and this directory is not one (no fluidcad.json or init.js).');
  }
  const target = await targetOf(mods, project, opts);
  await new HubInstallCli(mods, opts).installName(parsed, project, target);
}

async function runMissing(mods, project, opts) {
  if (!project) {
    fail('Run `fluidcad install` in a project: it installs the packages the project pins. To install a package, pass its name.');
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

/** A `.fluidpkg`, or any existing path that isn't a package name: refused (HD31). */
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
    .description('Install a package from the hub by name (a name alone: the hub\'s latest; name@version: your library, else the hub); with no arguments, download every package this project pins that is missing')
    .option('--library', 'Install into your package library (the default, unless Settings say otherwise)')
    .option('--project', "Install into this project's packages/ folder; with a package name in your library, copy it there")
    // Installs no longer ask; kept so scripts that pass it keep working.
    .addOption(new Option('-y, --yes').hideHelp())
    .option('--replace', 'Replace an installed copy of the same version whose contents differ')
    .option('--hub <url>', 'The hub to download from (default: FLUIDCAD_HUB_URL, else https://hub.fluidcad.io)')
    .action((arg, opts) => {
      runInstall(arg, opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
