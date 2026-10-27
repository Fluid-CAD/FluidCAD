import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';

/**
 * Where a project's editor types for its pinned packages live (Stage P8),
 * and how a path that goes through one is followed back to the package.
 *
 * tsserver (VS Code, Neovim) finds `@acme/gears` the way TypeScript finds
 * any untyped npm name: `node_modules/@types/acme__gears/index.d.ts`. That
 * folder is a **shim** the server keeps, marked by a {@link MARKER} file
 * beside the declaration, the way `node_modules/.fluidcad-engine-link`
 * marks the engine link. It holds:
 * - `installed`: a link to the installed package directory (the project
 *   copy or the user library);
 * - `index.d.ts`: the package entry's named re-exports, through that link.
 *
 * The re-exports go through the link, not to the installed directory's
 * absolute path, because the package's own `fluidcad/*` imports are
 * resolved from wherever TypeScript thinks the file is: from the library
 * a `node_modules` walk finds no engine and every type reads as `any`,
 * while from `<project>/node_modules/@types/…/installed/` it finds the
 * project's `node_modules/fluidcad`. TypeScript keeps the link's path for a
 * relative import (it resolves links only for a `node_modules` lookup).
 *
 * **Never `node_modules/@scope/name`**: Vite would resolve the package
 * there and externalize it past the engine (research M1, K11). Neither Vite
 * nor Node ever looks in `@types`.
 *
 * Deliberately free of the other package classes, so `PackageRoots` can
 * follow a shim's link without an import cycle.
 */
export class PackageTypeLinks {
  /** The folder under the project's `node_modules` the shims live in. */
  static readonly TYPES_DIR = '@types';
  /** Marks a shim folder as the server's: only marked folders are rewritten or removed. */
  static readonly MARKER = '.fluidcad-package-types';
  /** The link inside a shim to the installed package directory. */
  static readonly LINK = 'installed';
  /** The declaration TypeScript reads for the package's name. */
  static readonly DECLARATION = 'index.d.ts';

  /** `<anything>/node_modules/@types/<shim>/installed[/rest]`. */
  private static readonly THROUGH_LINK = /^(.*\/node_modules\/@types\/[^/]+)\/installed(\/.*)?$/;

  /** `<project>/node_modules/@types`. */
  static typesRoot(project: string): string {
    return normalizePath(path.join(project, 'node_modules', PackageTypeLinks.TYPES_DIR));
  }

  /** `@acme/gears` → `acme__gears`, the `@types` folder name TypeScript looks up for a scoped name; null for any other name. */
  static folderName(name: string): string | null {
    const match = /^@([^/]+)\/([^/]+)$/.exec(name);
    return match ? `${match[1]}__${match[2]}` : null;
  }

  /** Whether `dir` is a shim the server keeps (it holds the {@link MARKER}). */
  static isShim(dir: string): boolean {
    try {
      return fs.statSync(path.join(dir, PackageTypeLinks.MARKER)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * The real path of `file` when it is reached through a shim's link —
   * `<project>/node_modules/@types/acme__gears/installed/parts/spur.part.js`
   * is the installed package's `parts/spur.part.js` — or null for any
   * other path. Go to definition in tsserver opens the link's path, so the
   * read-only guard and the "never render a package file as the model" rule
   * ask through this.
   */
  static realPath(file: string): string | null {
    const match = PackageTypeLinks.THROUGH_LINK.exec(normalizePath(file));
    if (!match || !PackageTypeLinks.isShim(match[1])) {
      return null;
    }
    try {
      const target = normalizePath(fs.realpathSync(`${match[1]}/${PackageTypeLinks.LINK}`));
      return `${target}${match[2] ?? ''}`;
    } catch {
      return null;
    }
  }
}
