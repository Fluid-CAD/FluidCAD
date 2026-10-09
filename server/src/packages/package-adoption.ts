import type { DispatchRefusal } from '../edit-dispatch.ts';
import { PackageInstallError } from './package-installer.ts';
import { PackagePinError, PackagePins } from './package-pins.ts';
import { ProjectPackages } from './project-packages.ts';

/** What adopting a package for use wrote: the pin, or nothing when the project pinned it already. */
export type PackageAdoptionOutcome = {
  name: string;
  version: string;
  integrity: string;
  pin: 'pinned' | 'unchanged';
};

/**
 * Using a library package in a project pins it first (K7): the moment a
 * feature dialog's OK or an Insert part writes a statement that imports
 * `@scope/name`, the project's `fluidcad.json` gains
 * `dependencies[name] = { version, integrity }` — before the statement and
 * its import are written, so the render that follows the edit resolves the
 * name (pins are re-read per render). **No file is copied**: the package
 * keeps loading from the library. This is `MaterialCatalog.adoptForPick`'s
 * shape, minus the copy.
 *
 * The pin is what keeps a later library install (1.3.0 beside 1.2.0) from
 * changing this project's geometry, and the hash catches a library copy
 * that changed under it.
 */
export class PackageAdoption {
  /**
   * Pin `name` into `project` for use: `version` when the caller knows
   * which one it offered (the catalog entry's), else the newest one
   * installed. A project that already pins the package keeps its pin
   * (`unchanged`); asking for another version than the pinned one is
   * refused — switching a pin is Stage P10's previewed upgrade, never a
   * side effect of using a feature. Throws `PackagePinError` (a broken
   * `dependencies` map, a version change, files that differ from the pin)
   * or `PackageInstallError` (`not-installed`), each worded for the user.
   */
  static async adoptForUse(project: string, name: string, version?: string): Promise<PackageAdoptionOutcome> {
    const pinned = PackagePins.of(project)[name];
    if (pinned && (version === undefined || pinned.version === version)) {
      return { name, version: pinned.version, integrity: pinned.integrity, pin: 'unchanged' };
    }
    const used = await ProjectPackages.useInstalled(version ? `${name}@${version}` : name, project);
    return { name, version: used.location.version, integrity: used.integrity, pin: used.pin };
  }

  /**
   * An adoption's refusal as the edit's answer: 409 when the project's pin
   * stands in the way (another version, other contents), 422 otherwise —
   * each with the adoption's sentence and code. Null for any other error,
   * which the caller rethrows.
   */
  static refusal(err: unknown): DispatchRefusal | null {
    if (err instanceof PackagePinError) {
      const conflict = err.code === 'version-change' || err.code === 'integrity-mismatch';
      return { status: conflict ? 409 : 422, reason: err.message, code: err.code };
    }
    if (err instanceof PackageInstallError) {
      return { status: 422, reason: err.message, code: err.code };
    }
    return null;
  }

  /**
   * The dispatcher's `beforeSend` step that runs `adopt` and answers its
   * refusal: the one shape the feature create and the part insert share.
   */
  static step(adopt: () => Promise<unknown>): () => Promise<DispatchRefusal | null> {
    return async () => {
      try {
        await adopt();
        return null;
      } catch (err) {
        const refusal = PackageAdoption.refusal(err);
        if (refusal) {
          return refusal;
        }
        throw err;
      }
    };
  }
}
