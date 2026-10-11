import path from 'path';
import { PackageInstallError } from './package-installer.ts';
import { PackageLayout, type PackageManifest } from './package-manifest.ts';
import { PackageName } from './package-name.ts';
import { PackagePinError, PackagePins } from './package-pins.ts';

/**
 * The one place that decides an installed tree's public name (HD29).
 *
 * An archive only knows its author's bare name (`feature-tests`); the hub
 * knows who published it (`@acme/feature-tests`). A download from the hub
 * installs under the hub's name. A file installs under, in this order:
 * 1. the name given (`fluidcad install <file> --as @acme/feature-tests`),
 *    whose bare part must be the file's;
 * 2. the project's pin of that bare name, when the project pins exactly
 *    one (the missing-package banner's case: `PackagePins.check` then
 *    verifies the version and the hash);
 * 3. the reserved local scope, `@local/feature-tests` — a package the hub
 *    never has, so `fluidcad install` never asks it for an `@local` pin.
 *
 * The public name is where the tree goes (`<root>/@scope/name/<version>/`)
 * and what the project pins and imports; the archive is never changed.
 */
export class PackageIdentity {
  /** The scope of a package installed from a file under no other name; reserved on the hub. */
  static readonly LOCAL_SCOPE = PackagePins.LOCAL_SCOPE;

  /** Whether `name` is in the local scope (`@local/feature-tests`). */
  static isLocal(name: string): boolean {
    return PackageName.scope(name) === PackageIdentity.LOCAL_SCOPE;
  }

  /** `feature-tests` → `@local/feature-tests`. */
  static localName(bare: string): string {
    return PackageName.publicName(PackageIdentity.LOCAL_SCOPE, bare);
  }

  /** The public name an archive named `manifestName` installs under (see the class comment). */
  static forInstall(manifestName: string, options: { as?: string | null; project?: string | null } = {}): string {
    const as = options.as ?? null;
    if (as !== null) {
      if (!PackageName.isValid(as)) {
        throw new PackageInstallError('wrong-name', `${JSON.stringify(as)} is not a package name: ${PackageName.RULE}.`);
      }
      if (PackageName.bareOf(as) !== manifestName) {
        throw new PackageInstallError('wrong-name', `This file is ${manifestName}, so it can't install as ${as}.`);
      }
      return as;
    }
    const pinned = PackageIdentity.pinnedAs(manifestName, options.project ?? null);
    if (pinned.length > 1) {
      throw new PackageInstallError('ambiguous-name',
        `This project pins ${PackageIdentity.listed(pinned)}, and this file could be any of them: `
        + `name the one it is with --as, such as --as ${pinned[0]}.`);
    }
    if (pinned.length === 1) {
      return pinned[0];
    }
    return PackageIdentity.localName(manifestName);
  }

  /**
   * The public name a file's name suggests, for a hint only: the hub's
   * downloads are named `acme-feature-tests-0.1.0.fluidpkg`, its handle
   * before the package's bare name and version. Null when the file isn't
   * named that way, or names no handle (or the local scope).
   */
  static hintFromFileName(fileName: string, manifest: Pick<PackageManifest, 'name' | 'version'>): string | null {
    const base = path.basename(fileName.replace(/\\/g, '/'));
    const suffix = `-${manifest.name}-${manifest.version}${PackageLayout.EXTENSION}`;
    if (!base.endsWith(suffix)) {
      return null;
    }
    const handle = base.slice(0, -suffix.length);
    if (!PackageName.isHandle(handle) || handle === PackageIdentity.LOCAL_SCOPE) {
      return null;
    }
    const name = `@${handle}/${manifest.name}`;
    return PackageName.isValid(name) ? name : null;
  }

  /**
   * The refusal for an `@local` package that isn't installed: the hub
   * never has one, so it names the file install instead.
   */
  static localSentence(name: string, version: string | null): string {
    const which = version ? `${name} ${version}` : name;
    return `${which} ${PackagePins.FROM_A_FILE}`;
  }


  /** The project's pins whose bare name is `bare`, sorted; none without a project or with unreadable pins. */
  private static pinnedAs(bare: string, project: string | null): string[] {
    if (!project || !PackagePins.isProject(project)) {
      return [];
    }
    let pins: Record<string, unknown>;
    try {
      pins = PackagePins.of(project);
    } catch (err) {
      if (err instanceof PackagePinError) {
        return [];
      }
      throw err;
    }
    return Object.keys(pins).filter((name) => PackageName.bareOf(name) === bare).sort();
  }

  private static listed(names: string[]): string {
    if (names.length <= 2) {
      return names.join(' and ');
    }
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
}
