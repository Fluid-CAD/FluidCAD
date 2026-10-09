import { normalizePath } from '../normalize-path.ts';
import { PackageInstaller, type PackageFolderCopy } from './package-installer.ts';
import { PackageRoots } from './package-roots.ts';

/** What the folder the library left still holds that the library doesn't: the copy Settings → Packages offers. */
export type LibraryOffer = {
  /** The folder the library was in before the last change. */
  path: string;
  /** Its packages the current library lacks (by name and version). */
  packages: { name: string; version: string }[];
};

/**
 * Changing Settings → Packages "Library folder" moves nothing (research §3):
 * projects pin by name and version, not by path, so the old folder's
 * packages simply stop being found. This remembers the folder the library
 * resolved to before the last change, for as long as this engine runs, so
 * the tab can offer to copy those packages into the new folder — and does
 * the copy, tree by tree, through the installer.
 *
 * The folder is only ever one the library really was in: the copy route
 * takes no path, so a page can't copy an arbitrary folder into the library
 * past the install's checks.
 */
export class LibraryMove {
  private static previous: string | null = null;

  /**
   * A preferences save moved the library from `before` to `after` (or
   * didn't): a move remembers `before`; coming back to the remembered folder
   * forgets it.
   */
  static note(before: string, after: string): void {
    const from = normalizePath(before);
    const to = normalizePath(after);
    if (from !== to) {
      LibraryMove.previous = from;
    }
    if (LibraryMove.previous === to) {
      LibraryMove.previous = null;
    }
  }

  /** The offer to show, or null: no move, or nothing in the old folder the library lacks. */
  static offer(): LibraryOffer | null {
    const from = LibraryMove.previous;
    if (!from || from === PackageRoots.libraryPath()) {
      return null;
    }
    const present = new Set(PackageRoots.installedIn({ target: 'library', root: PackageRoots.libraryPath() })
      .map((location) => `${location.name}@${location.version}`));
    const packages = PackageRoots.installedAt(from)
      .filter((location) => !present.has(`${location.name}@${location.version}`))
      .map(({ name, version }) => ({ name, version }));
    return packages.length > 0 ? { path: from, packages } : null;
  }

  /** Copy the old folder's packages into the library; null when there is no old folder to copy from. */
  static async copy(project?: string | null): Promise<{ from: string; copies: PackageFolderCopy[] } | null> {
    const from = LibraryMove.previous;
    if (!from || from === PackageRoots.libraryPath()) {
      return null;
    }
    const copies = await PackageInstaller.copyFolder(from, project);
    return { from, copies };
  }

  /** The user declined the offer ("Leave them"): it isn't made again until the folder changes again. */
  static dismiss(): void {
    LibraryMove.previous = null;
  }
}
