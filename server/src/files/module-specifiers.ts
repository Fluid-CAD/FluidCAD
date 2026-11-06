import { dirname, resolve } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { readProjectConfig, type PackageDependencies } from '../project-config.ts';
import { PackageManifests } from '../packages/package-manifests.ts';
import type { PackageManifest } from '../packages/package-manifest.ts';
import { PackageResolveError, PackageResolver, type ResolvedPackage } from '../packages/resolver.ts';
import { PackageRoots, type PackageLocation } from '../packages/package-roots.ts';
import { relativeSpecifier } from './relative-specifier.ts';

/** What an import specifier names from a file: the engine's core, a workspace module, or a module of a pinned package. */
export type ModuleTarget =
  | { kind: 'built-in' }
  | { kind: 'workspace'; path: string }
  | {
    kind: 'package';
    /** The declaring module the imported name comes from, or the package's entry when no name was asked. */
    path: string;
    package: ResolvedPackage;
    manifest: PackageManifest;
  };

/**
 * The one answer to "which specifier reaches module M from file F", and its
 * reverse, "which module a specifier names from F" (research §5). The code
 * writers ask it for the import they write (a custom feature's create, a
 * part insert), and the readers ask it which module an import they found
 * names (the feature catalog's callees, a declaration's importers):
 *
 * - a workspace module is reached by a relative path (`./standoff.feature.js`);
 * - a module of an installed package is reached by the package's bare name
 *   (`@acme/gears`), and only when the package's entry exports the name —
 *   a package's helpers are its own (K2);
 * - the engine's own builders come from `fluidcad/core`.
 *
 * A package is resolved only through the project's pins (K7): the reverse
 * of a bare name is the pinned version's directory (the project copy first,
 * then the library), and the forward refuses a module of a version other
 * than the pinned one, since the bare name would load the pinned one. A
 * name the project doesn't pin yet is written bare all the same; the code
 * writer pins it first (`PackageAdoption`). Without a project
 * ({@link LOCAL}) there are no packages, only workspace modules and the core.
 *
 * Pins are read once per instance: make one per catalog listing or code
 * write, so a pin written a moment ago is seen.
 */
export class ModuleSpecifiers {
  /** The module the engine's own builders are imported from. */
  static readonly CORE = 'fluidcad/core';

  /** No project: workspace modules and the core only. */
  static readonly LOCAL = new ModuleSpecifiers(null);

  private resolver: PackageResolver | null = null;
  private pins: PackageDependencies | null = null;

  constructor(readonly project: string | null) {}

  /** `fluidcad/core`, or `fluidcad` (both spellings the editor writes the core in). */
  static isBuiltIn(specifier: string): boolean {
    return specifier === ModuleSpecifiers.CORE || specifier === 'fluidcad';
  }

  static isRelative(specifier: string): boolean {
    return specifier.startsWith('./') || specifier.startsWith('../');
  }

  /**
   * Whether two specifiers written in `fromFile` name the same module: the
   * two spellings of the core, two relative paths to one file
   * (`./sub/../a.feature.js`), or one bare package name. Needs no disk,
   * so the code transform can ask it.
   */
  static sameModule(a: string, b: string, fromFile: string): boolean {
    if (ModuleSpecifiers.isBuiltIn(a) || ModuleSpecifiers.isBuiltIn(b)) {
      return ModuleSpecifiers.isBuiltIn(a) && ModuleSpecifiers.isBuiltIn(b);
    }
    if (ModuleSpecifiers.isRelative(a) && ModuleSpecifiers.isRelative(b)) {
      return ModuleSpecifiers.resolveRelative(fromFile, a) === ModuleSpecifiers.resolveRelative(fromFile, b);
    }
    return a === b;
  }

  /** The absolute path a relative specifier spells from `fromFile`, as written (no suffix added). */
  static resolveRelative(fromFile: string, specifier: string): string {
    return normalizePath(resolve(dirname(normalizePath(fromFile)), specifier));
  }

  /**
   * The specifier `fromFile` imports `exportName` of `module` by: the core
   * for a built-in (`module` `fluidcad/core`), the package's bare name for
   * a module of an installed package, a relative path otherwise. Null when
   * the module can't be reached under that name: a package module its entry
   * doesn't export the name from, or a version of a package other than the
   * one the project pins.
   */
  specifierFor(fromFile: string, module: string, exportName: string): string | null {
    if (ModuleSpecifiers.isBuiltIn(module)) {
      return ModuleSpecifiers.CORE;
    }
    const owner = this.packageOwning(module);
    if (owner === null) {
      return relativeSpecifier(fromFile, module);
    }
    const manifest = PackageManifests.of(owner.directory);
    const inside = PackageManifests.modulePathIn(owner.directory, normalizePath(module));
    if (!manifest || inside === null || !PackageManifests.exports(manifest, inside, exportName)) {
      return null;
    }
    const pinned = this.pinsNow()[owner.name];
    if (pinned && pinned.version !== owner.version) {
      return null;
    }
    return owner.name;
  }

  /**
   * Why {@link specifierFor} answered null for a package module, as a
   * sentence; null when the module isn't a package's or is reachable.
   */
  unreachableReason(module: string, exportName: string): string | null {
    const owner = this.packageOwning(module);
    if (owner === null) {
      return null;
    }
    const pinned = this.pinsNow()[owner.name];
    if (pinned && pinned.version !== owner.version) {
      return `This project uses \`${owner.name}\` ${pinned.version}, not ${owner.version}; ` +
        `switching the version it pins isn't supported yet.`;
    }
    const manifest = PackageManifests.of(owner.directory);
    const inside = PackageManifests.modulePathIn(owner.directory, normalizePath(module));
    if (!manifest || inside === null || !PackageManifests.exports(manifest, inside, exportName)) {
      return `\`${owner.name}\` ${owner.version} doesn't export \`${exportName}\`` +
        `${inside ? ` from ${inside}` : ''}, so it can't be imported by the package's name.`;
    }
    return null;
  }

  /**
   * The module `specifier` names from `fromFile`: the core, a workspace path
   * (resolved as written), or — for a bare name the project pins and can
   * load — the module of that package `importedName` comes from (its
   * entry, when no name is asked). Null for anything else: an npm import, a
   * package the project doesn't pin or can't load (the render says why), a
   * name the package doesn't export, or any package without a project.
   */
  moduleOf(specifier: string, fromFile: string, importedName?: string): ModuleTarget | null {
    if (ModuleSpecifiers.isBuiltIn(specifier)) {
      return { kind: 'built-in' };
    }
    if (ModuleSpecifiers.isRelative(specifier)) {
      return { kind: 'workspace', path: ModuleSpecifiers.resolveRelative(fromFile, specifier) };
    }
    if (this.project === null) {
      return null;
    }
    const resolved = this.resolverNow().resolve(specifier, fromFile);
    if (resolved === null || resolved instanceof PackageResolveError) {
      return null;
    }
    const manifest = PackageManifests.of(resolved.directory);
    if (!manifest) {
      return null;
    }
    if (importedName === undefined) {
      return { kind: 'package', path: resolved.entry, package: resolved, manifest };
    }
    const module = PackageManifests.moduleOf(manifest, importedName);
    if (module === null) {
      return null;
    }
    return { kind: 'package', path: normalizePath(`${resolved.directory}/${module}`), package: resolved, manifest };
  }

  /**
   * Whether `specifier`, written in `fromFile`, reaches `target`: a relative
   * path that spells it (the `.js` may be left off: `./a.part` reaches
   * `a.part.js`), or the bare name of the pinned package whose entry
   * re-exports `importedName` from it (any name the entry re-exports from
   * it, when none is given).
   */
  reaches(fromFile: string, specifier: string, target: string, importedName?: string): boolean {
    const wanted = normalizePath(target);
    if (ModuleSpecifiers.isRelative(specifier)) {
      const base = ModuleSpecifiers.resolveRelative(fromFile, specifier);
      return ModuleSpecifiers.OMITTABLE_SUFFIXES.some((suffix) => base + suffix === wanted);
    }
    const found = this.moduleOf(specifier, fromFile, importedName);
    if (found?.kind !== 'package') {
      return false;
    }
    if (importedName !== undefined) {
      return found.path === wanted;
    }
    const inside = PackageManifests.modulePathIn(found.package.directory, wanted);
    return wanted === found.path
      || (inside !== null && [...found.manifest.features, ...found.manifest.parts].some((entry) => entry.module === inside));
  }

  /** Suffixes a workspace import may leave off. */
  private static readonly OMITTABLE_SUFFIXES: readonly string[] = ['', '.js'];

  /** The installed package `module` lies in, for this project; none without a project. */
  private packageOwning(module: string): PackageLocation | null {
    if (this.project === null) {
      return null;
    }
    return PackageRoots.owner(normalizePath(module), this.project);
  }

  private resolverNow(): PackageResolver {
    if (this.resolver === null) {
      this.resolver = new PackageResolver({ project: this.project });
    }
    return this.resolver;
  }

  /** The project's pins, read once; a broken map reads as none. */
  private pinsNow(): PackageDependencies {
    if (this.pins === null) {
      const config = this.project ? readProjectConfig(this.project) : null;
      this.pins = config && !config.problems?.dependencies ? config.dependencies ?? {} : {};
    }
    return this.pins;
  }
}
