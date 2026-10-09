import fs from 'fs';
import path from 'path';
import {
  PROJECT_CONFIG_FILENAME,
  isProjectConfigUnreadable,
  readProjectConfig,
  writeDependency,
  type PackageDependencies,
} from '../project-config.ts';
import { PackageRoots, type PackageTarget } from './package-roots.ts';

export type PackagePinErrorCode = 'not-a-project' | 'unreadable-config' | 'broken-dependencies' | 'version-change' | 'integrity-mismatch';

/** A refusal to write a pin, worded for the user. */
export class PackagePinError extends Error {
  constructor(readonly code: PackagePinErrorCode, message: string) {
    super(message);
    this.name = 'PackagePinError';
  }
}

/** Where a pinned package is found for its project, if anywhere. */
export type PackageAvailability = PackageTarget | 'missing';

/** One pin, and where it is installed. */
export type PinnedPackage = {
  name: string;
  version: string;
  integrity: string;
  availability: PackageAvailability;
  /** The installed directory; null when the pin is missing. */
  directory: string | null;
};

/**
 * A project's package pins (K5): `fluidcad.json` `dependencies`, one exact
 * version plus the tree hash per package. This is the only place a pin is
 * written, and its one rule is that a pin never silently changes: a pin to
 * another version is Stage P10's previewed upgrade, and a pin to the same
 * version with another hash means the files aren't the ones the project
 * was built with.
 */
export class PackagePins {
  /** A directory holding `fluidcad.json` or `init.js`: what the CLI pins into when it runs there. */
  static isProject(dir: string): boolean {
    return fs.existsSync(path.join(dir, PROJECT_CONFIG_FILENAME)) || fs.existsSync(path.join(dir, 'init.js'));
  }

  /** The project's pins; empty when it pins nothing. A broken map is refused rather than read as empty. */
  static of(project: string): PackageDependencies {
    const config = readProjectConfig(project);
    if (config.problems?.dependencies) {
      throw new PackagePinError('broken-dependencies', `${config.problems.dependencies} Fix it first.`);
    }
    return config.dependencies ?? {};
  }

  /**
   * Whether pinning `name` at `version` with `integrity` is new (`pin`),
   * already there (`unchanged`), or refused. Checked before anything is
   * installed, so a refusal leaves the library, the project copy and
   * `fluidcad.json` as they were.
   */
  static check(project: string, name: string, version: string, integrity: string): 'pin' | 'unchanged' {
    if (!PackagePins.isProject(project)) {
      throw new PackagePinError('not-a-project', `${project} is not a FluidCAD project (no fluidcad.json or init.js), so nothing can be pinned there.`);
    }
    const config = readProjectConfig(project);
    if (isProjectConfigUnreadable(config)) {
      throw new PackagePinError('unreadable-config', `${config.error} Fix it before pinning a package.`);
    }
    const existing = PackagePins.of(project)[name];
    if (!existing) {
      return 'pin';
    }
    if (existing.version !== version) {
      throw new PackagePinError('version-change',
        `This project pins ${name} ${existing.version}; pinning ${version} instead would change its geometry, and upgrading a pin isn't supported yet. ` +
        `The pin was left at ${existing.version}.`);
    }
    if (existing.integrity !== integrity) {
      throw new PackagePinError('integrity-mismatch',
        `This project pins ${name} ${version} with different contents (${existing.integrity}); these files aren't the package the project was built with. ` +
        'The pin was left as it was.');
    }
    return 'unchanged';
  }

  /** Write the pin after {@link check}; a pin already there writes nothing. */
  static pin(project: string, name: string, version: string, integrity: string): 'pinned' | 'unchanged' {
    if (PackagePins.check(project, name, version, integrity) === 'unchanged') {
      return 'unchanged';
    }
    writeDependency(project, name, { version, integrity });
    return 'pinned';
  }

  /** Every pin of the project and where it is installed: the project copy first, then the library. */
  static availability(project: string): PinnedPackage[] {
    return Object.entries(PackagePins.of(project))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, pin]) => {
        const location = PackageRoots.locate(name, pin.version, project);
        return {
          name,
          version: pin.version,
          integrity: pin.integrity,
          availability: location?.target ?? 'missing',
          directory: location?.directory ?? null,
        };
      });
  }

  /** The pins installed in neither root. */
  static missing(project: string): PinnedPackage[] {
    return PackagePins.availability(project).filter((pin) => pin.availability === 'missing');
  }
}
