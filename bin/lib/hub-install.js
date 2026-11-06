import { HubCli } from './hub.js';
import { count, InstallLine, loadPackages, size } from './packages.js';

/**
 * `fluidcad install` from the hub (hub-plan H8): the terminal around the
 * server's `HubInstaller`, which chooses between an installed copy and the
 * hub (`choose`), resolves, downloads and verifies, and the existing
 * install path (`ProjectPackages.installInspected`). It installs straight
 * away, without asking (the user, 2026-10-13); package code still never
 * runs, and nothing lands in a root, before the archive is downloaded and
 * its files hash to what the hub (and the project's pin) lists.
 *
 * Each package is one line (`InstallLine`): what happened, what it holds,
 * what happened to the pin, then a short line per warning. On a terminal a
 * `Downloading …` line shows while it downloads, then gives way to it.
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
    this.progress = new ProgressLine();
    /** The refused-token line is said once, not under every package. */
    this.saidSignedOut = false;
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

  /** An installed copy: pinned (and with `--project` copied in) in a project, or "already there" outside one. */
  async useInstalled(choice, project) {
    const { mods, opts } = this;
    const { location, resolved } = choice;
    const { name, version } = location;
    const warnings = choice.unreachable
      ? [`Couldn't reach ${this.config.origin}: this is the newest version in ${this.where(location.target)}; the hub may have a newer one.`]
      : resolved ? this.notices(resolved) : [];
    if (!project) {
      InstallLine.print(`${name}@${version} is already in ${this.where(location.target)}`, mods.PackageManifests.of(location.directory), null, warnings);
      return;
    }
    const outcome = await mods.ProjectPackages.useInstalled(`${name}@${version}`, project, { copy: opts.project === true });
    let head;
    if (outcome.copied) {
      head = InstallLine.head(outcome.copied, this.where(outcome.copied.target));
    } else if (opts.project) {
      head = `${name}@${version} is already in ${this.where('project')}`;
    } else {
      head = `Using ${name}@${version} from ${this.where(outcome.location.target)}`;
    }
    InstallLine.print(head, mods.PackageManifests.of(outcome.location.directory), outcome.pin, warnings);
  }

  /** A download from the hub, verified, then installed into `target` and pinned when in a project. */
  async download(resolved, project, target) {
    const { mods, opts } = this;
    const root = mods.PackageRoots.rootFor(target, project);
    const { name, version } = resolved;
    const pin = project ? mods.PackagePins.of(project)[name] ?? null : null;
    if (project) {
      // A pin that would change refuses before anything is downloaded.
      mods.PackagePins.check(project, name, version, resolved.integrity);
    }

    this.progress.show(`Downloading ${name}@${version}${resolved.size ? ` (${size(resolved.size)})` : ''}…`);
    let inspection;
    let outcome;
    try {
      ({ inspection } = await this.installer.fetch(resolved, { root, pin: pin?.version === version ? pin.integrity : null }));
      outcome = await this.install(inspection, {
        target,
        project,
        pin: project !== null,
        replace: opts.replace === true,
      });
    } finally {
      this.progress.clear();
    }
    InstallLine.print(InstallLine.head(outcome, this.where(target)), inspection.manifest, outcome.pin, this.warningsOf(resolved, inspection));
  }

  /**
   * Every pin in `missing` (installed in neither root), each at its pinned
   * version and integrity: a line per install, then a line per failure,
   * exiting 1 when any failed.
   */
  async installMissing(missing, project, target) {
    const { mods } = this;
    const root = mods.PackageRoots.rootFor(target, project);
    console.log(`This project pins ${count(missing.length, 'package')} that ${missing.length === 1 ? "isn't" : "aren't"} installed; downloading from ${this.config.origin}.`);
    let result;
    try {
      result = await this.installer.missing(missing, {
        root,
        onStart: (pin) => this.progress.show(`Downloading ${pin.name}@${pin.version}…`),
      });
    } finally {
      this.progress.clear();
    }
    const failures = result.failed.map((failure) => ({ name: failure.name, version: failure.version, message: failure.error.message }));

    for (const { inspection, resolved } of result.fetched) {
      const { name, version } = inspection.manifest;
      try {
        // The pin is already there: the line doesn't repeat it.
        const outcome = await this.install(inspection, { target, project, pin: true });
        InstallLine.print(InstallLine.head(outcome, this.where(target)), inspection.manifest, null, this.warningsOf(resolved, inspection));
      } catch (err) {
        failures.push({ name, version, message: err?.message ?? String(err) });
      }
    }

    if (failures.length > 0) {
      HubInstallCli.printFailures(failures);
      process.exit(1);
    }
  }

  /** Installs a verified inspection; one that doesn't install is dropped from the scratch. */
  async install(inspection, request) {
    try {
      return await this.mods.ProjectPackages.installInspected({ token: inspection.token, ...request });
    } catch (err) {
      this.mods.PackageArchive.discard(inspection.token);
      throw err;
    }
  }

  /** What to say under a downloaded package: the hub's word on it, then the archive's own warnings (a newer FluidCAD needed, another SDK). */
  warningsOf(resolved, inspection) {
    return [...this.notices(resolved), ...inspection.warnings.map((warning) => warning.message)];
  }

  /**
   * The hub's word on `resolved`, one short line each, from its fields (the
   * app shows `resolved.notes`, the full sentences): deprecated, not
   * published, an older version than the latest, a refused token.
   */
  notices(resolved) {
    const lines = [];
    if (resolved.deprecated) {
      lines.push(`Deprecated: ${resolved.deprecated}`);
    }
    if (resolved.status !== 'published') {
      const state = resolved.status.replace(/_/g, ' ');
      lines.push(`Not published (${state}): installed as its ${resolved.access === 'admin' ? 'reviewer' : 'owner'}.`);
    }
    if (resolved.passedOver) {
      lines.push(`The latest, ${resolved.passedOver.version}, needs ${resolved.passedOver.needs}.`);
    }
    if (resolved.signedOut && !this.saidSignedOut) {
      this.saidSignedOut = true;
      lines.push(`${resolved.hub} refused your saved token, so this ran signed out: run \`fluidcad login\` to sign in again.`);
    }
    return lines;
  }

  /** "your library" or "this project's packages folder". */
  where(target) {
    return this.mods.PackageInstaller.describe(target);
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

/**
 * A line that shows what is under way on a terminal (`Downloading …`) and is
 * cleared before what comes next; nothing at all when stdout isn't one.
 */
class ProgressLine {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.shown = false;
  }

  show(text) {
    if (!this.stream.isTTY) {
      return;
    }
    this.stream.write(`\r\x1b[2K${text}`);
    this.shown = true;
  }

  clear() {
    if (this.shown) {
      this.stream.write('\r\x1b[2K');
      this.shown = false;
    }
  }
}
