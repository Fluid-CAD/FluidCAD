import fs from 'fs';
import path from 'path';
import { SDK_VERSION } from '../../../lib/dist/sdk/version.js';
import { ENGINE_PACKAGE_ROOT } from '../host/engine-resolution.ts';
import { normalizePath } from '../normalize-path.ts';
import { readProjectConfig, type PackageDependencies } from '../project-config.ts';
import { PackageIntegrity } from './package-integrity.ts';
import { PackageLayout } from './package-manifest.ts';
import { PackageManifests } from './package-manifests.ts';
import { PackageName } from './package-name.ts';
import { PackagePins } from './package-pins.ts';
import { PackageRoots, type PackageLocation } from './package-roots.ts';
import { Semver } from './semver.ts';

/** An installed package directory: `<root>/@scope/name/<version>/`, under the library or the project copy. */
export type PackageRoot = PackageLocation;

/** What an import of a package's name loads: its generated entry, and the pin it was checked against. */
export type ResolvedPackage = PackageRoot & {
  /** `<directory>/index.js`. */
  entry: string;
  /** The tree hash the project pins, which the directory was checked against. */
  integrity: string;
};

export type PackageResolveErrorCode =
  | 'node-modules-copy'
  | 'subpath'
  | 'missing-entry'
  | 'not-pinned'
  | 'broken-pins'
  | 'missing'
  | 'integrity'
  | 'min-engine'
  | 'sdk-version'
  | 'package-import';

/**
 * Why an import of a package's name cannot load. Returned, not thrown, by
 * `PackageResolver.resolve`, so each caller decides how it fails: the Vite
 * host throws it as the module's error, a catalog lookup reads it as "no".
 * `version` is the pinned version when the refusal is about one — what a
 * missing package's Install action needs.
 */
export class PackageResolveError extends Error {
  constructor(
    readonly packageName: string,
    readonly code: PackageResolveErrorCode,
    message: string,
    readonly version: string | null = null,
  ) {
    super(message);
    this.name = 'PackageResolveError';
  }
}

export type PackageResolverOptions = {
  /** The project whose pins decide; the host sets it when it opens its workspace (see {@link PackageResolver.setProject}). */
  project?: string | null;
  /** The running engine's version, compared with a package's `minEngine`. Defaults to this engine's own. */
  engineVersion?: string;
  /** The running engine's `SDK_VERSION`, compared with a package's `sdkVersion`. Defaults to this engine's own. */
  sdkVersion?: number;
};

/**
 * Answers which installed package an import of `@scope/name` loads, and
 * which package owns a file.
 *
 * **A package is resolved only through the importing project's pins**
 * (K5, K7): `fluidcad.json` `dependencies` names the exact version and the
 * tree hash, and the directory is found in the project copy first, then the
 * user library (`PackageRoots.rootsFor`). The pins are re-read on every
 * render ({@link refresh}), so pinning, unpinning or switching a version
 * shows on the next render with no restart. A pin that can't load is
 * refused with a sentence (research §3):
 * - the name isn't pinned;
 * - neither root has the pinned version;
 * - the installed tree's hash differs from the pin (cached by directory and
 *   a stamp of its files: {@link PackageIntegrity});
 * - the package needs a newer engine (`minEngine`), or was built against
 *   another feature SDK (`sdkVersion`, K10).
 *
 * A package is imported by its bare scoped name and loads from its
 * installed directory, never through a `node_modules` folder (K11): Vite
 * externalizes a name it can resolve there to Node's own `import()`, which
 * bypasses the engine import steering and the per-render re-evaluation. A
 * `node_modules` copy of a pinned name is therefore refused; an unpinned
 * name a `node_modules` folder holds is an ordinary npm import, someone
 * else's to resolve.
 */
export class PackageResolver {
  /** `@scope/name`, the package's name (HD30). The grammar, lengths included, lives in `PackageName`. */
  static readonly NAME_PATTERN = PackageName.PATTERN;

  /** The generated entry every installed package carries (K2). */
  static readonly ENTRY_FILE = PackageLayout.ENTRY;

  private project: string | null;
  private readonly engineVersion: string;
  private readonly sdkVersion: number;
  /** The project's pins as this render read them; undefined until first asked after a {@link refresh}. */
  private pins: { map: PackageDependencies; problem: string | null } | undefined;
  /** Per name, what this render's first resolution of it answered (the `node_modules` check is per importer and runs every time). */
  private readonly outcomes = new Map<string, ResolvedPackage | PackageResolveError>();
  /** Every package this render loaded, by name. */
  private readonly loaded = new Map<string, ResolvedPackage>();
  /** Every refusal this render answered, one per name. */
  private readonly refusals = new Map<string, PackageResolveError>();

  constructor(options: PackageResolverOptions = {}) {
    this.project = options.project ? PackageResolver.canonicalDirectory(options.project) : null;
    this.engineVersion = options.engineVersion ?? PackageResolver.runningEngineVersion();
    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
  }

  /** The project whose pins decide: the workspace the host opened. */
  setProject(project: string | null): void {
    this.project = project ? PackageResolver.canonicalDirectory(project) : null;
    this.refresh();
  }

  getProject(): string | null {
    return this.project;
  }

  /**
   * Start over for a new render: the pins are read again on the next
   * resolution, every answer is asked again, and the installed-directory
   * verdicts are dropped so a package removed by another process reads as
   * missing at once.
   */
  refresh(): void {
    this.pins = undefined;
    this.outcomes.clear();
    this.loaded.clear();
    this.refusals.clear();
    PackageRoots.forgetInstalled();
  }

  /**
   * The package name and the path after it in a bare scoped specifier
   * (`@acme/kit` → `{ name: '@acme/kit', subpath: '' }`), or null for any
   * other specifier.
   */
  static parseSpecifier(specifier: string): { name: string; subpath: string } | null {
    const match = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(specifier);
    if (!match || !PackageName.isValid(match[1])) {
      return null;
    }
    return { name: match[1], subpath: match[2] ?? '' };
  }

  /** Every package this render loaded, in the order it first loaded them. */
  resolved(): ResolvedPackage[] {
    return [...this.loaded.values()];
  }

  /** Every refusal this render answered, one per package name. */
  problems(): PackageResolveError[] {
    return [...this.refusals.values()];
  }

  /**
   * What `specifier`, imported from `importer`, loads: the package's entry,
   * or why it cannot load. Null when the specifier is no package import —
   * not a scoped name, or an unpinned name a `node_modules` folder above the
   * importer holds (an npm import, someone else's to resolve).
   */
  resolve(specifier: string, importer?: string | null): ResolvedPackage | PackageResolveError | null {
    const parsed = PackageResolver.parseSpecifier(specifier);
    if (!parsed) {
      return null;
    }
    const { name, subpath } = parsed;
    const copy = importer ? PackageResolver.nodeModulesCopy(name, importer) : null;
    const pin = this.pinsNow().map[name];
    if (!pin && copy) {
      return null;
    }
    const owner = importer ? this.rootOf(PackageResolver.importerFile(importer)) : null;
    if (owner) {
      return this.refuse(new PackageResolveError(name, 'package-import',
        `${owner.name} ${owner.version} imports \`${name}\`, but a package can't import another package yet.`));
    }
    if (pin && subpath !== '') {
      return this.refuse(new PackageResolveError(name, 'subpath',
        `\`${specifier}\`: a package is imported by its name only — import { … } from '${name}'.`, pin.version));
    }
    if (pin && copy) {
      return this.refuse(PackageResolver.nodeModulesRefusal(name, copy));
    }
    const known = this.outcomes.get(name);
    if (known) {
      return known instanceof PackageResolveError ? this.refuse(known) : known;
    }
    const outcome = this.load(name);
    this.outcomes.set(name, outcome);
    if (outcome instanceof PackageResolveError) {
      return this.refuse(outcome);
    }
    this.loaded.set(name, outcome);
    return outcome;
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

  /**
   * The installed package that owns `file` — under the project copy or the
   * library, location plus marker (`PackageRoots.owner`) — or null.
   */
  rootOf(file: string): PackageRoot | null {
    const target = normalizePath(file.split('?')[0]);
    if (!path.isAbsolute(target)) {
      return null;
    }
    return PackageRoots.owner(target, this.project);
  }

  /** The pinned package `name` loads from, or why it can't (every check but the per-importer ones). */
  private load(name: string): ResolvedPackage | PackageResolveError {
    const pins = this.pinsNow();
    const pin = pins.map[name];
    if (!pin) {
      if (pins.problem) {
        return new PackageResolveError(name, 'broken-pins',
          `\`${name}\` can't be loaded: ${pins.problem} Fix the project's dependencies first.`);
      }
      return new PackageResolveError(name, 'not-pinned',
        `\`${name}\` is not a dependency of this project — install it or add it from your library.`);
    }
    const location = PackageRoots.locate(name, pin.version, this.project);
    if (!location) {
      return new PackageResolveError(name, 'missing', PackagePins.missingSentence(name, pin.version), pin.version);
    }
    let integrity: string;
    try {
      integrity = PackageIntegrity.of(location.directory);
    } catch {
      integrity = '';
    }
    if (integrity !== pin.integrity) {
      return new PackageResolveError(name, 'integrity',
        `The installed \`${name}\` ${pin.version} differs from the one this project was built with.`, pin.version);
    }
    const refusal = this.engineRefusal(name, pin.version, PackageManifests.of(location.directory));
    if (refusal) {
      return refusal;
    }
    const entry = `${location.directory}/${PackageResolver.ENTRY_FILE}`;
    if (!fs.existsSync(entry)) {
      return new PackageResolveError(name, 'missing-entry',
        `\`${name}\` at ${location.directory} has no ${PackageResolver.ENTRY_FILE}, so it cannot be imported.`, pin.version);
    }
    return { ...location, entry, integrity: pin.integrity };
  }

  /**
   * Why this engine can't run `name` `version`, whose manifest is
   * `manifest`, or null when it can: the package needs a newer engine
   * (`minEngine`), or was built against another feature SDK (`sdkVersion`,
   * K10). The catalogs ask it too, so a package this engine would refuse at
   * render is never offered as usable.
   */
  engineRefusal(name: string, version: string, manifest: { minEngine?: unknown; sdkVersion?: unknown } | null): PackageResolveError | null {
    const minEngine = typeof manifest?.minEngine === 'string' ? Semver.parse(manifest.minEngine) : null;
    const running = Semver.parse(this.engineVersion);
    if (minEngine && running && Semver.compare(minEngine, running) > 0) {
      return new PackageResolveError(name, 'min-engine',
        `\`${name}\` ${version} needs FluidCAD ${manifest!.minEngine} or newer; this engine is ${this.engineVersion}.`, version);
    }
    if (typeof manifest?.sdkVersion === 'number' && manifest.sdkVersion !== this.sdkVersion) {
      return new PackageResolveError(name, 'sdk-version',
        `\`${name}\` ${version} was built against feature SDK version ${manifest.sdkVersion}; ` +
        `this engine has version ${this.sdkVersion}.`, version);
    }
    return null;
  }

  private refuse(error: PackageResolveError): PackageResolveError {
    if (!this.refusals.has(error.packageName)) {
      this.refusals.set(error.packageName, error);
    }
    return error;
  }

  /** The project's pins, read once per render; a broken map reads as no pins, with its sentence. */
  private pinsNow(): { map: PackageDependencies; problem: string | null } {
    if (this.pins === undefined) {
      if (!this.project) {
        this.pins = { map: {}, problem: null };
      } else {
        const config = readProjectConfig(this.project);
        this.pins = { map: config.dependencies ?? {}, problem: config.problems?.dependencies ?? null };
      }
    }
    return this.pins;
  }

  /** This engine's version, from its own `package.json`. */
  private static runningEngineVersion(): string {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(ENGINE_PACKAGE_ROOT, 'package.json'), 'utf8'));
      return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private static importerFile(importer: string): string {
    return importer.replace(/^virtual:live-render:/, '').split('?')[0];
  }

  /**
   * The `node_modules/<name>` a Node resolution from `importer` would land
   * on — the same upward walk Vite's external check makes — or null.
   */
  private static nodeModulesCopy(name: string, importer: string): string | null {
    const file = PackageResolver.importerFile(importer);
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

  /** The project directory, normalized and with links resolved (macOS `/var` → `/private/var`). */
  private static canonicalDirectory(directory: string): string {
    const absolute = path.resolve(directory);
    try {
      return normalizePath(fs.realpathSync(absolute)).replace(/\/+$/, '');
    } catch {
      return normalizePath(absolute).replace(/\/+$/, '');
    }
  }
}
