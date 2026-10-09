import { PackageArchive } from './package-archive.ts';
import {
  PackageInstallError,
  PackageInstaller,
  type InstalledPackage,
  type PackageInstallResult,
} from './package-installer.ts';
import { PackageName } from './package-name.ts';
import { PackagePinError, PackagePins, type PinnedPackage } from './package-pins.ts';
import { PackageRoots, type PackageLocation, type PackageTarget } from './package-roots.ts';
import { Semver } from './semver.ts';
import { TreeHash } from './tree-hash.ts';

export type InstallInspectedRequest = {
  token: string;
  target: PackageTarget;
  /** The open project; needed for the `project` target and for a pin. */
  project?: string | null;
  /** Pin into the project even when installing into the library. A project target always pins. */
  pin?: boolean;
  replace?: boolean;
};

/** An install, and what it did to the project's pin: null when it pinned nothing. */
export type InstallOutcome = PackageInstallResult & { pin: 'pinned' | 'unchanged' | null };

/** `fluidcad install @scope/name[@version]`: where the package was found, and what changed. */
export type UseInstalledOutcome = {
  location: PackageLocation;
  integrity: string;
  pin: 'pinned' | 'unchanged';
  /** The copy into the project, when one was asked for and the package came from the library. */
  copied: PackageInstallResult | null;
};

export type RemoveOutcome = {
  removed: PackageLocation;
  /** The open project's pin of the removed version when nothing installs it any more; null otherwise. */
  strandedPin: PinnedPackage | null;
};

/** The two roots and a project's pins, as `fluidcad packages` and `GET /api/packages` show them. */
export type PackagesOverview = {
  /** `source`: where the path comes from — `FLUIDCAD_PACKAGES`, the Settings preference, or the default. */
  library: { path: string; source: 'env' | 'preference' | 'default'; packages: InstalledPackage[] };
  /** Null outside a project. */
  project: { path: string; packages: InstalledPackage[] } | null;
  /** Null outside a project. */
  pins: PinnedPackage[] | null;
  /** Why the pins couldn't be read (a broken `dependencies` map). */
  pinsProblem?: string;
  /**
   * Each pinned package the library holds a newer version of, with the
   * newest one: the "update available" chip (the previewed upgrade is
   * Stage P10's). Empty outside a project.
   */
  updates: Record<string, string>;
};

/**
 * The install flows a project sees, shared by the CLI and the routes:
 * install an inspected archive and pin it, pin (and optionally copy in) a
 * package already installed, and the overview of both roots plus the pins.
 * A pin is checked before anything is installed or copied, so a refused
 * pin leaves everything as it was.
 */
export class ProjectPackages {
  static async installInspected(request: InstallInspectedRequest): Promise<InstallOutcome> {
    const inspection = PackageArchive.peek(request.token);
    if (!inspection) {
      throw new PackageInstallError('unknown-token', 'That inspected package is gone (installed already, or it expired); inspect the file again.');
    }
    const project = request.project ?? null;
    const pinning = request.target === 'project' || request.pin === true;
    const { name, version } = inspection.manifest;
    if (pinning) {
      if (!project) {
        throw new PackagePinError('not-a-project', `There is no open project to pin ${name} ${version} into.`);
      }
      PackagePins.check(project, name, version, inspection.integrity);
    }
    const result = await PackageInstaller.install(request.token, request.target, { project, replace: request.replace });
    const pin = pinning ? PackagePins.pin(project!, name, version, result.integrity) : null;
    return { ...result, pin };
  }

  /**
   * Pin an installed package into `project` (`@scope/name`, or
   * `@scope/name@version`), and with `copy` copy it from the library into
   * the project too. Without a version it takes the version the project
   * already pins, else the newest one installed.
   */
  static async useInstalled(spec: string, project: string, options: { copy?: boolean } = {}): Promise<UseInstalledOutcome> {
    const { name, version: asked } = ProjectPackages.parseSpec(spec);
    if (!PackagePins.isProject(project)) {
      throw new PackagePinError('not-a-project', `${project} is not a FluidCAD project (no fluidcad.json or init.js), so nothing can be pinned there.`);
    }
    const version = asked ?? PackagePins.of(project)[name]?.version ?? ProjectPackages.newest(name, project);
    const location = version ? PackageRoots.locate(name, version, project) : null;
    if (!version || !location) {
      const which = asked ? `${name} ${asked}` : name;
      throw new PackageInstallError('not-installed', `${which} isn't in your library — install it from a file.`);
    }
    const integrity = await TreeHash.ofDirectory(location.directory);
    PackagePins.check(project, name, version, integrity);
    const copied = options.copy && location.target === 'library'
      ? await PackageInstaller.copy(name, version, 'project', project)
      : null;
    const pin = PackagePins.pin(project, name, version, integrity);
    return { location: copied ?? location, integrity, pin, copied };
  }

  /**
   * Take an installed package out of `target`. When the open project pins
   * that version and no root holds it any more, `strandedPin` is the pin:
   * the project will ask for the package again (research §3, Settings).
   */
  static remove(name: string, version: string | null, target: PackageTarget, project?: string | null): RemoveOutcome {
    const removed = PackageInstaller.remove(name, version, target, project);
    let strandedPin: PinnedPackage | null = null;
    if (project && PackagePins.isProject(project)) {
      try {
        strandedPin = PackagePins.missing(project).find((pin) => pin.name === name && pin.version === removed.version) ?? null;
      } catch (err) {
        if (!(err instanceof PackagePinError)) {
          throw err;
        }
      }
    }
    return { removed, strandedPin };
  }

  static overview(project?: string | null): PackagesOverview {
    const overview: PackagesOverview = {
      library: { path: PackageRoots.libraryPath(), source: PackageRoots.librarySource(), packages: PackageInstaller.list('library', project) },
      project: null,
      pins: null,
      updates: {},
    };
    if (project) {
      overview.project = { path: PackageRoots.projectCopyPath(project), packages: PackageInstaller.list('project', project) };
      try {
        overview.pins = PackagePins.availability(project);
        overview.updates = ProjectPackages.updates(overview.pins, overview.library.packages);
      } catch (err) {
        if (!(err instanceof PackagePinError)) {
          throw err;
        }
        overview.pins = [];
        overview.pinsProblem = err.message;
      }
    }
    return overview;
  }

  /** The newest library version above each pin, for the pins that have one. */
  static updates(pins: readonly PinnedPackage[], library: readonly PackageLocation[]): Record<string, string> {
    const updates: Record<string, string> = {};
    for (const pin of pins) {
      const pinned = Semver.parse(pin.version);
      if (!pinned) {
        continue;
      }
      let newest: Semver | null = null;
      for (const installed of library) {
        const version = installed.name === pin.name ? Semver.parse(installed.version) : null;
        if (version && Semver.compare(version, pinned) > 0 && (!newest || Semver.compare(version, newest) > 0)) {
          newest = version;
        }
      }
      if (newest) {
        updates[pin.name] = newest.toString();
      }
    }
    return updates;
  }

  /** `@acme/gears` or `@acme/gears@1.2.0`. */
  static parseSpec(spec: string): { name: string; version: string | null } {
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : null;
    if (!PackageName.isValid(name)) {
      throw new PackageInstallError('not-installed', `${JSON.stringify(spec)} is not a package name: ${PackageName.RULE}.`);
    }
    if (version !== null && !Semver.isValid(version)) {
      throw new PackageInstallError('not-installed', `${JSON.stringify(version)} is not a version, as in ${name}@1.2.0.`);
    }
    return { name, version };
  }

  /** The newest version of `name` installed in either root. */
  private static newest(name: string, project: string): string | null {
    const versions = PackageRoots.rootsFor(project)
      .flatMap((root) => PackageRoots.installedIn(root, project))
      .filter((entry) => entry.name === name)
      .map((entry) => Semver.parse(entry.version)!)
      .sort(Semver.compare);
    return versions.length > 0 ? versions[versions.length - 1].toString() : null;
  }
}
