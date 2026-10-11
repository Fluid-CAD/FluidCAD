import { HubCli } from './hub.js';
import { consented, count, describeTarget, installedLine, loadPackages, printConsentSummary, printPin, size } from './packages.js';

/**
 * `fluidcad install` from the hub (hub-plan H8): the terminal around the
 * server's `HubInstaller`, which chooses between an installed copy and the
 * hub (`choose`), resolves, downloads and verifies, and the
 * existing consent and install path (`ProjectPackages.installInspected`).
 * Nothing is installed or pinned before the consent summary is answered
 * (or `--yes` given), and package code never runs before then.
 *
 * Reads carry the token when signed in (`HubCredentials.read`: the
 * environment's first), so the owner and admins can install an unpublished
 * version by its exact version.
 */
export class HubInstallCli {
  /** The package classes, the hub classes and the installer, imported lazily. */
  static async load() {
    const [packages, hub, installer, installError] = await Promise.all([
      loadPackages(),
      HubCli.load(),
      import('../../server/dist/hub/hub-installer.js'),
      import('../../server/dist/hub/hub-install-error.js'),
    ]);
    return {
      ...packages,
      ...hub,
      HubInstaller: installer.HubInstaller,
      HubInstallError: installError.HubInstallError,
      HubInstallMessages: installError.HubInstallMessages,
    };
  }

  /** `opts.hub` picks the hub (`--hub`, then `FLUIDCAD_HUB_URL`, then the default). */
  constructor(mods, opts) {
    this.mods = mods;
    this.opts = opts;
    this.config = HubCli.config(mods, opts);
    const credential = mods.HubCredentials.read(this.config.origin);
    this.installer = new mods.HubInstaller({
      config: this.config,
      token: credential?.token ?? null,
      engineVersion: HubCli.version(),
      transport: new mods.HubTransport({ version: HubCli.version(), client: 'cli' }),
    });
  }

  /**
   * One package by name: `HubInstaller.choose` decides between an installed
   * copy (pinned, and with `--project` copied in) and a download from the
   * hub (`spec.version`, else the pin, else the latest this engine runs).
   */
  async installName(spec, project, target) {
    const choice = await this.installer.choose(spec, { project });
    if (choice.source === 'installed') {
      await this.useInstalled(choice, project);
      return;
    }
    await this.download(choice.resolved, project, target);
  }

  /** An installed copy: its notes, then the pin (and the copy) in a project, or "already there" outside one. */
  async useInstalled(choice, project) {
    const { mods, opts } = this;
    const { location, resolved, notes } = choice;
    const { name, version } = location;
    for (const note of notes) {
      console.log(note);
    }
    if (!project) {
      const contents = resolved ? ", with the hub's contents: nothing changed." : '.';
      console.log(`${name} ${version} is already in ${describeTarget(mods, location.target, location.directory)}${contents}`);
      return;
    }
    const outcome = await mods.ProjectPackages.useInstalled(`${name}@${version}`, project, { copy: opts.project === true });
    if (outcome.copied) {
      console.log(installedLine(mods, outcome.copied));
    } else if (opts.project) {
      console.log(`${name} ${version} is already in ${describeTarget(mods, 'project', outcome.location.directory)}.`);
    }
    printPin(outcome.pin, name, version, outcome.copied ? null : outcome.location.target);
  }

  /** A download from the hub, verified, after the consent summary, into `target`, pinned when in a project. */
  async download(resolved, project, target) {
    const { mods, opts } = this;
    const root = mods.PackageRoots.rootFor(target, project);
    const { name, version } = resolved;
    const pin = project ? mods.PackagePins.of(project)[name] ?? null : null;
    if (project) {
      // A pin that would change refuses before anything is downloaded.
      mods.PackagePins.check(project, name, version, resolved.integrity);
    }

    console.log(`Downloading ${name} ${version}${resolved.size ? ` (${size(resolved.size)})` : ''} from ${resolved.hub}…`);
    const { inspection } = await this.installer.fetch(resolved, { root, pin: pin?.version === version ? pin.integrity : null });
    try {
      const vouchers = pin?.version === version ? `${resolved.hub} and this project's pin say` : `${resolved.hub} says`;
      console.log(`Verified: its files hash to ${inspection.integrity}, as ${vouchers}.`);
      printConsentSummary(inspection, resolved.notes);
      console.log(`Installing into ${describeTarget(mods, target, root)}${project ? ', and pinning it in this project' : ''}.`);
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
   * Every pin in `missing` (installed in neither root), each at its pinned
   * version and integrity: one consent summary for all of them, one
   * confirmation, then a line per install. Exits 1 when any failed, with a
   * line per failure.
   */
  async installMissing(missing, project, target) {
    const { mods, opts } = this;
    const root = mods.PackageRoots.rootFor(target, project);
    console.log(`This project pins ${count(missing.length, 'package')} that ${missing.length === 1 ? "isn't" : "aren't"} installed; downloading from ${this.config.origin}.`);
    const result = await this.installer.missing(missing, {
      root,
      onStart: (pin) => console.log(`Downloading ${pin.name} ${pin.version}…`),
    });
    const failures = result.failed.map((failure) => ({ name: failure.name, version: failure.version, message: failure.error.message }));

    if (result.fetched.length > 0) {
      try {
        for (const { inspection, resolved } of result.fetched) {
          console.log('');
          printConsentSummary(inspection, resolved.notes);
        }
        console.log('');
        const verified = result.fetched.length === 1 ? 'Verified: its files hash to its pin' : "Verified: each one's files hash to its pin";
        console.log(`${verified}, as ${this.config.origin} says. Installing ${result.fetched.length === 1 ? 'it' : 'them'} into ${describeTarget(mods, target, root)}.`);
        const question = result.fetched.length === 1 ? 'Install it?' : `Install these ${result.fetched.length}?`;
        if (!opts.yes && !(await consented(question))) {
          mods.HubInstaller.discard(result.fetched);
          console.error('Nothing was installed.');
          HubInstallCli.printFailures(failures);
          process.exit(1);
        }
      } catch (err) {
        mods.HubInstaller.discard(result.fetched);
        throw err;
      }
      for (const { inspection } of result.fetched) {
        const { name, version } = inspection.manifest;
        try {
          const outcome = await mods.ProjectPackages.installInspected({ token: inspection.token, target, project, pin: true });
          console.log(installedLine(mods, outcome));
        } catch (err) {
          mods.PackageArchive.discard(inspection.token);
          failures.push({ name, version, message: err?.message ?? String(err) });
        }
      }
    }

    if (failures.length > 0) {
      HubInstallCli.printFailures(failures);
      process.exit(1);
    }
  }

  static printFailures(failures) {
    if (failures.length === 0) {
      return;
    }
    console.error(`Couldn't install ${count(failures.length, 'package')}:`);
    for (const failure of failures) {
      console.error(`  ${failure.name} ${failure.version}: ${failure.message}`);
    }
  }
}
