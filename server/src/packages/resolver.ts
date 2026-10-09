import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';
import { PackageName } from './package-name.ts';

/** An installed package directory: `<root>/@scope/name/<version>/`. */
export type PackageRoot = {
  /** The scoped name, `@scope/name`. */
  name: string;
  /** The version its `manifest.json` names, or null when it names none. */
  version: string | null;
  /** The directory, normalized and with links resolved. */
  directory: string;
};

/** What an import of a package's name loads: its generated entry. */
export type ResolvedPackage = PackageRoot & {
  /** `<directory>/index.js`. */
  entry: string;
};

export type PackageResolveErrorCode = 'node-modules-copy' | 'subpath' | 'missing-entry';

/**
 * Why an import of a package's name cannot load. Returned, not thrown, by
 * `PackageResolver.resolve`, so each caller decides how it fails: the Vite
 * host throws it as the module's error, a catalog lookup reads it as "no".
 */
export class PackageResolveError extends Error {
  constructor(
    readonly packageName: string,
    readonly code: PackageResolveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackageResolveError';
  }
}

/**
 * Answers which installed package an import of `@scope/name` loads, and
 * which package owns a file.
 *
 * A package is imported by its bare scoped name and loads from its installed
 * directory, never through a `node_modules` folder (K11): Vite externalizes a
 * name it can resolve there to Node's own `import()`, which bypasses the
 * engine import steering and the per-render re-evaluation. A `node_modules`
 * copy of a known name is therefore refused, with a sentence that says where
 * it is.
 *
 * Stage P1 takes the packages as an injected `{ name → directory }` map;
 * Stage P5 replaces it with the importing project's pins.
 */
export class PackageResolver {
  /** `@scope/name`: lowercase letters, digits and dashes (research §1). The grammar lives in `PackageName`. */
  static readonly NAME_PATTERN = PackageName.PATTERN;

  /** The generated entry every installed package carries (K2). */
  static readonly ENTRY_FILE = 'index.js';

  private readonly directories = new Map<string, string>();
  private readonly versions = new Map<string, string | null>();

  constructor(packages: Record<string, string> = {}) {
    for (const [name, directory] of Object.entries(packages)) {
      if (!PackageResolver.NAME_PATTERN.test(name)) {
        throw new Error(`"${name}" is not a package name: packages are named @scope/name, in lowercase.`);
      }
      this.directories.set(name, PackageResolver.canonicalDirectory(directory));
    }
  }

  /**
   * The package name and the path after it in a bare scoped specifier
   * (`@acme/kit` → `{ name: '@acme/kit', subpath: '' }`), or null for any
   * other specifier.
   */
  static parseSpecifier(specifier: string): { name: string; subpath: string } | null {
    const match = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(specifier);
    if (!match || !PackageResolver.NAME_PATTERN.test(match[1])) {
      return null;
    }
    return { name: match[1], subpath: match[2] ?? '' };
  }

  /** Every package this resolver knows, in no particular order. */
  roots(): PackageRoot[] {
    return [...this.directories.keys()].map(name => this.rootNamed(name));
  }

  /**
   * What `specifier`, imported from `importer`, loads: the package's entry,
   * or why it cannot load. Null when the specifier names no package this
   * resolver knows — every other import is someone else's to resolve.
   */
  resolve(specifier: string, importer?: string | null): ResolvedPackage | PackageResolveError | null {
    const parsed = PackageResolver.parseSpecifier(specifier);
    if (!parsed || !this.directories.has(parsed.name)) {
      return null;
    }
    const { name, subpath } = parsed;
    if (subpath !== '') {
      return new PackageResolveError(name, 'subpath',
        `\`${specifier}\`: a package is imported by its name only — import { … } from '${name}'.`);
    }
    const copy = importer ? PackageResolver.nodeModulesCopy(name, importer) : null;
    if (copy) {
      return PackageResolver.nodeModulesRefusal(name, copy);
    }
    const root = this.rootNamed(name);
    const entry = `${root.directory}/${PackageResolver.ENTRY_FILE}`;
    if (!fs.existsSync(entry)) {
      return new PackageResolveError(name, 'missing-entry',
        `\`${name}\` at ${root.directory} has no ${PackageResolver.ENTRY_FILE}, so it cannot be imported.`);
    }
    return { ...root, entry };
  }

  /**
   * The refusal for a package that loads through `node_modules` (K11).
   * `copy` is where it was found, or null when only the loader knows it went
   * there (Vite externalized the name before any resolver was asked).
   */
  static nodeModulesRefusal(name: string, copy: string | null): PackageResolveError {
    const where = copy ? `a copy of \`${name}\` at ${copy}` : `\`${name}\` resolved through a node_modules folder`;
    return new PackageResolveError(name, 'node-modules-copy',
      `FluidCAD packages never load from node_modules, but ${where} would shadow the installed package. ` +
      'Remove it so the engine loads the installed copy.');
  }

  /** The installed package that owns `file`, or null when no package does. */
  rootOf(file: string): PackageRoot | null {
    const target = normalizePath(file.split('?')[0]);
    for (const [name, directory] of this.directories) {
      if (target === directory || target.startsWith(`${directory}/`)) {
        return this.rootNamed(name);
      }
    }
    return null;
  }

  private rootNamed(name: string): PackageRoot {
    const directory = this.directories.get(name)!;
    return { name, version: this.versionOf(directory), directory };
  }

  /** The `version` of a package's `manifest.json`, read once per directory. */
  private versionOf(directory: string): string | null {
    if (this.versions.has(directory)) {
      return this.versions.get(directory)!;
    }
    let version: string | null = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      version = typeof manifest?.version === 'string' ? manifest.version : null;
    } catch {
      version = null;
    }
    this.versions.set(directory, version);
    return version;
  }

  /**
   * The `node_modules/<name>` a Node resolution from `importer` would land
   * on — the same upward walk Vite's external check makes — or null.
   */
  private static nodeModulesCopy(name: string, importer: string): string | null {
    const file = importer.replace(/^virtual:live-render:/, '').split('?')[0];
    if (!path.isAbsolute(file)) {
      return null;
    }
    let dir = path.dirname(file);
    for (;;) {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'));
      if (fs.existsSync(candidate)) {
        return normalizePath(candidate);
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
  }

  /**
   * One spelling per directory: Vite names a module by its real path, so a
   * package under a linked folder (macOS `/var` → `/private/var`) must be
   * recognised by that path too.
   */
  private static canonicalDirectory(directory: string): string {
    const absolute = path.resolve(directory);
    try {
      return normalizePath(fs.realpathSync(absolute)).replace(/\/+$/, '');
    } catch {
      return normalizePath(absolute).replace(/\/+$/, '');
    }
  }
}
