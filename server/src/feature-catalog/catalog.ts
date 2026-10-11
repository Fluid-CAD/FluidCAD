import { realpathSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { PROJECT_CONFIG_FILENAME } from '../project-config.ts';
import { ModuleSpecifiers } from '../files/module-specifiers.ts';
import { PackageOffers, type PackageOffer, type PackageRef } from '../packages/package-offers.ts';
import { PackageAdoption, type PackageAdoptionOutcome } from '../packages/package-adoption.ts';
import { getJavaScriptParser, namedImportBindings, type NamedImportBinding, type TSTree } from '../code-editor/index.ts';
import {
  CustomFeatureStatement,
  FeatureCallees,
  type CustomFeatureCallee,
  type FeatureCalleeSource,
} from '../apply-feature-edit/index.ts';
import { ScanCache } from '../part-catalog/cache.ts';
import { FeatureKey, listFeatureAssets, type FeatureMetaSnapshot } from '../../../lib/dist/index.js';
import { FeatureModules } from './walk.ts';
import { FeatureScanner, type FeatureScanResult } from './scan.ts';
import { RawOcctUse } from './raw-occt.ts';

/**
 * One feature the editor can offer: a builder a feature module exports, or
 * one of the engine's own builders that carries metadata. A module that
 * fails to evaluate is listed too, as one entry with an `error` and no
 * feature — the UI says what is wrong with it instead of leaving the
 * feature off the toolbar unexplained.
 */
export type FeatureCatalogEntry = {
  /**
   * The feature's catalog key: its plain id (`standoff`) for the
   * workspace's own features and the built-ins, keyed by the package for an
   * installed package's (`@acme/feature-tests:standoff`); null for a module
   * that did not evaluate.
   */
  id: string | null;
  /** The name the builder is imported by; null for a module that did not evaluate. */
  exportName: string | null;
  /**
   * The declaring module's absolute path — for a package's feature, the
   * module inside its installed directory, never the generated entry, so
   * the feature's images resolve beside it — or `fluidcad/core` for a
   * built-in.
   */
  modulePath: string;
  builtIn: boolean;
  /**
   * The installed package the feature comes from, and whether the project
   * pins it (`dependency`) or it is the library's newest version of a
   * package the project doesn't use yet (`library`, K7): using one pins it
   * first. Absent for the workspace's own features and the built-ins.
   */
  package?: PackageRef;
  meta: FeatureMetaSnapshot | null;
  /**
   * The feature's module — or a workspace module it imports — reaches raw
   * OpenCascade (`fluidcad/sdk/occt`, or a scope opened with `this.occ()`;
   * see {@link RawOcctUse}): unstable code that can corrupt the kernel's
   * memory for the whole engine session. Read from the source, never
   * evaluated; a package's feature carries what its manifest says (the
   * packer read the source). False for the engine's own builders. Kept in the engine —
   * a kernel trap names it as the likeliest cause — and never served to
   * the page.
   */
  usesOcct: boolean;
  /** Why this entry can't be offered. */
  error?: string;
};

export type FeatureCatalogOptions = {
  workspacePath: string;
  /**
   * Evaluate one feature module (see {@link FeatureScanner.scanFile});
   * resolves null while the engine is not up yet.
   */
  scan: (absPath: string) => Promise<FeatureScanResult | null>;
  /** The engine's own builders, as the `fluidcad/core` namespace. Defaults to this server's kernel. */
  builtIns?: () => Promise<object>;
  /** Whether an editor buffer overlays a file: a module depending on one is rescanned, never served from the mtime cache. */
  hasLiveBuffer?: (absPath: string) => boolean;
};

/** Where one of a feature's declared images is served from, or why it isn't. */
export type FeatureAssetLookup = { file: string } | { status: number; error: string };

/**
 * The features a workspace offers: every `*.feature.js` module's exported
 * builders (discovered by evaluating the module and scanning its exports —
 * nothing registers itself), plus the engine's own builders that carry
 * metadata, plus the features of installed packages (K7): those the
 * project pins, and the newest library version of each one it doesn't
 * (see {@link PackageOffers}). Module scans are cached by the mtimes of
 * everything the module imported; a package's features are read from its
 * manifest's snapshots, and its module is evaluated only when a dialog
 * needs the live builder (a ghost, through `FeatureScanner.loadBuilder`).
 *
 * The catalog is also how the code-writing layer learns what a call in a
 * file builds: {@link resolveCallee} follows the file's import of a callee
 * to the feature it names, and {@link calleesFor} turns a file's imports
 * into the {@link FeatureCallees} its producer gates consult.
 */
export class FeatureCatalog implements FeatureCalleeSource {
  /** The module a built-in feature is imported from. */
  static readonly BUILT_IN_MODULE = FeatureScanner.CORE_MODULE;

  private readonly workspacePath: string;
  private readonly cache = new ScanCache<FeatureScanResult>();
  private readonly inflight = new Map<string, Promise<FeatureScanResult | null>>();
  /** The files each scanned module's features declare (icons, option images), by module. */
  private readonly assets = new Map<string, Set<string>>();
  private builtInEntries: Promise<FeatureCatalogEntry[]> | null = null;

  constructor(private readonly options: FeatureCatalogOptions) {
    this.workspacePath = options.workspacePath ? normalizePath(options.workspacePath) : '';
  }

  /**
   * Every feature, built-ins first, then each module in path order, then
   * the packages' (pinned ones, then the library's); null while the engine
   * is not up. An id two builders share marks both entries with an error —
   * which one a statement means would depend on the walk order, and the id
   * is what the timeline and the cache key on. A library entry is only an
   * offer, so one whose id the project already has (its own module, a
   * built-in, a pinned package) is left out rather than marking the
   * project's own.
   */
  async list(): Promise<FeatureCatalogEntry[] | null> {
    const entries = [...await this.builtIns()];
    for (const modulePath of await FeatureModules.list(this.workspacePath)) {
      const moduleEntries = await this.moduleEntries(modulePath);
      if (moduleEntries === null) {
        return null;
      }
      entries.push(...moduleEntries);
    }
    const offered = PackageOffers.of(this.workspacePath || null).flatMap(offer => FeatureCatalog.packageEntries(offer));
    entries.push(...offered.filter(entry => entry.package?.availability === 'dependency'));
    const used = new Set(entries.map(entry => entry.id).filter((id): id is string => id !== null));
    entries.push(...offered.filter(entry => entry.package?.availability === 'library' && !used.has(entry.id!)));
    return FeatureCatalog.markSharedIds(entries);
  }

  /**
   * The specifier `filePath` imports an entry's builder by
   * ({@link ModuleSpecifiers.specifierFor}): a relative path, the package's
   * bare name, or the core. Null when the file can't reach it under its
   * export name.
   */
  importSpecifier(entry: FeatureCatalogEntry, filePath: string): string | null {
    if (entry.exportName === null) {
      return null;
    }
    return this.specifiers().specifierFor(filePath, entry.modulePath, entry.exportName);
  }

  /** Why {@link importSpecifier} answered null for an entry, as a sentence. */
  unreachableReason(entry: FeatureCatalogEntry): string {
    return (entry.exportName ? this.specifiers().unreachableReason(entry.modulePath, entry.exportName) : null)
      ?? `${entry.meta?.label ?? entry.id ?? 'This feature'} can't be imported here.`;
  }

  /**
   * Pin a library entry's package into the project before a statement
   * using it is written (K7, {@link PackageAdoption.adoptForUse}); null for
   * an entry that needs no pin (a workspace feature, a built-in, a package
   * the project pins already). Throws the adoption's refusal.
   */
  async adoptForUse(entry: FeatureCatalogEntry): Promise<PackageAdoptionOutcome | null> {
    if (entry.package?.availability !== 'library' || !this.workspacePath) {
      return null;
    }
    return PackageAdoption.adoptForUse(this.workspacePath, entry.package.name, entry.package.version);
  }

  /**
   * The feature a call to `calleeName` builds in `filePath`: the file's
   * import of that name, followed to the module it names and matched
   * against the module's exports — so an alias (`import { standoff as so }`)
   * resolves `so`. Null for a name the file declares itself, imports from
   * anything but a feature module, a package the project pins, or
   * `fluidcad/core`, or that names no feature there.
   */
  async resolveCallee(tree: TSTree, calleeName: string, filePath: string): Promise<FeatureCatalogEntry | null> {
    const binding = namedImportBindings(tree).get(calleeName);
    return binding ? this.entryFor(binding, filePath) : null;
  }

  /**
   * What the calls in a file build: every name it imports, resolved as
   * {@link resolveCallee} does, with the shape its statements are read and
   * written by.
   */
  async calleesFor(code: string, filePath: string): Promise<FeatureCallees> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const custom = new Map<string, CustomFeatureCallee>();
    const specifiers = this.specifiers();
    for (const [local, binding] of namedImportBindings(tree)) {
      const entry = await this.entryFor(binding, filePath, specifiers);
      if (entry?.meta) {
        custom.set(local, { id: entry.meta.id, kind: entry.meta.kind, shape: CustomFeatureStatement.shapeOf(entry.meta) });
      }
    }
    return custom.size === 0 ? FeatureCallees.BUILT_IN : new FeatureCallees(custom);
  }

  /**
   * The file behind one of a feature's declared images: its icon, or an
   * option's image. `path` must be exactly one the metadata declares
   * ({@link listFeatureAssets}), and the file must stay inside the
   * module's directory once symlinks are resolved — the metadata check
   * refuses `..` already, so this guards the request and the links on disk.
   */
  async asset(id: string, path: string): Promise<FeatureAssetLookup> {
    const entries = await this.list();
    if (entries === null) {
      return { status: 503, error: 'Engine not initialized yet' };
    }
    const entry = entries.find(e => e.id === id && e.meta !== null && !e.builtIn && e.error === undefined);
    if (!entry || !entry.meta) {
      return { status: 404, error: `no feature '${id}' in this workspace` };
    }
    if (!listFeatureAssets(entry.meta).includes(path)) {
      return { status: 404, error: `feature '${id}' declares no asset '${path}'` };
    }
    const directory = dirname(entry.modulePath);
    let realDirectory: string;
    let realFile: string;
    try {
      realDirectory = realpathSync(directory);
      realFile = realpathSync(resolve(directory, path));
    } catch {
      return { status: 404, error: `feature '${id}': '${path}' does not exist next to its module` };
    }
    if (!realFile.startsWith(realDirectory + sep)) {
      return { status: 403, error: `feature '${id}': '${path}' leads outside its module's directory` };
    }
    return { file: realFile };
  }

  /**
   * A workspace file changed on disk: drop the scans it invalidates and say
   * whether the catalog may have changed — the file is a feature module,
   * one a cached module imports, an image a scanned feature declares (its
   * metadata stands, but the page must fetch the image again), or the
   * project's `fluidcad.json`, whose pins decide which packages' features
   * are dependencies and which are library offers.
   */
  noteFileChange(absPath: string): boolean {
    const file = normalizePath(absPath);
    const dropped = this.cache.dropDependents(file);
    return FeatureModules.isModule(file) || dropped || this.declaresAsset(file) || this.isProjectConfig(file);
  }

  private isProjectConfig(file: string): boolean {
    return this.workspacePath !== '' && file === `${this.workspacePath}/${PROJECT_CONFIG_FILENAME}`;
  }

  /** Whether a scanned module's features declare the file as an image. */
  private declaresAsset(file: string): boolean {
    for (const declared of this.assets.values()) {
      if (declared.has(file)) {
        return true;
      }
    }
    return false;
  }

  /** Keep the files a module's features declare, from its latest scan; a module that declares none is forgotten. */
  private noteAssets(modulePath: string, result: FeatureScanResult): void {
    const directory = dirname(modulePath);
    const declared = new Set<string>();
    for (const feature of result.features) {
      for (const asset of listFeatureAssets(feature.meta)) {
        declared.add(normalizePath(resolve(directory, asset)));
      }
    }
    if (declared.size > 0) {
      this.assets.set(modulePath, declared);
    } else {
      this.assets.delete(modulePath);
    }
  }

  /** The catalog entries one module yields; null while the engine is not up. */
  private async moduleEntries(modulePath: string): Promise<FeatureCatalogEntry[] | null> {
    const result = await this.scanned(modulePath);
    if (result === null) {
      return null;
    }
    const usesOcct = result.usesOcct === true;
    const failed = (error: string): FeatureCatalogEntry[] =>
      [{ id: null, exportName: null, modulePath, builtIn: false, meta: null, usesOcct, error }];
    if (result.error !== undefined) {
      return failed(result.error);
    }
    if (result.features.length === 0) {
      return failed('the module exports no feature — export the builder registerBuilder(…, { feature }) returns, by name');
    }
    return result.features.map(feature => ({
      id: feature.meta.id,
      exportName: feature.exportName,
      modulePath,
      builtIn: false,
      meta: feature.meta,
      usesOcct,
    }));
  }

  /** One module's scan: cached by its dependencies' mtimes, unless an editor buffer overlays one of them. */
  private async scanned(modulePath: string): Promise<FeatureScanResult | null> {
    const live = (result: FeatureScanResult) => result.deps.some(dep => this.options.hasLiveBuffer?.(dep) ?? false);
    const cached = this.cache.get(modulePath);
    if (cached && !live(cached)) {
      return cached;
    }
    let pending = this.inflight.get(modulePath);
    if (!pending) {
      pending = this.scanWithSource(modulePath).finally(() => this.inflight.delete(modulePath));
      this.inflight.set(modulePath, pending);
    }
    const result = await pending;
    if (result && !live(result)) {
      this.cache.set(modulePath, result);
    }
    return result;
  }

  /**
   * Evaluate the module, then read its source (and its imports') for raw
   * OpenCascade. A file only that read reached joins the scan's
   * dependencies, so changing it drops the cached answer too.
   */
  private async scanWithSource(modulePath: string): Promise<FeatureScanResult | null> {
    const result = await this.options.scan(modulePath);
    if (result === null) {
      return null;
    }
    this.noteAssets(modulePath, result);
    const raw = await RawOcctUse.scan(modulePath, this.workspacePath);
    const deps = result.deps.length > 0 ? [...new Set([...result.deps, ...raw.files])] : result.deps;
    return { ...result, deps, usesOcct: raw.usesOcct };
  }

  private builtIns(): Promise<FeatureCatalogEntry[]> {
    if (!this.builtInEntries) {
      const namespace = this.options.builtIns?.() ?? FeatureScanner.core();
      this.builtInEntries = namespace.then(core => FeatureScanner.featuresOf(core).map(feature => ({
        id: feature.meta.id,
        exportName: feature.exportName,
        modulePath: FeatureCatalog.BUILT_IN_MODULE,
        builtIn: true,
        meta: feature.meta,
        usesOcct: false,
      })));
    }
    return this.builtInEntries;
  }

  /** The feature an import binding names, in the module its specifier resolves to from `filePath`. */
  private async entryFor(binding: NamedImportBinding, filePath: string, specifiers = this.specifiers()): Promise<FeatureCatalogEntry | null> {
    const target = specifiers.moduleOf(binding.source, filePath, binding.imported);
    let entries: FeatureCatalogEntry[] | null;
    if (target === null) {
      return null;
    } else if (target.kind === 'built-in') {
      entries = await this.builtIns();
    } else if (target.kind === 'package') {
      entries = FeatureCatalog.packageEntries({
        name: target.package.name,
        version: target.package.version,
        availability: 'dependency',
        directory: target.package.directory,
        manifest: target.manifest,
      }).filter(entry => entry.modulePath === target.path);
    } else if (this.isWorkspaceModule(target.path)) {
      entries = await this.moduleEntries(target.path);
    } else {
      return null;
    }
    return entries?.find(entry => entry.exportName === binding.imported && entry.meta !== null) ?? null;
  }

  /** A feature module inside the workspace (installed copies are pruned from the walk, not reached here). */
  private isWorkspaceModule(absPath: string): boolean {
    return this.workspacePath !== '' && FeatureModules.isModule(absPath) && absPath.startsWith(this.workspacePath + '/');
  }

  /** Who answers which module a specifier names: one per question, so the pins it reads are the current ones. */
  private specifiers(): ModuleSpecifiers {
    return this.workspacePath ? new ModuleSpecifiers(this.workspacePath) : ModuleSpecifiers.LOCAL;
  }

  /**
   * A package's features as catalog entries, from its manifest's snapshots:
   * each at its declaring module, with the package it belongs to. A
   * package that can't be used here (`offer.problem`) gives its features
   * as error entries carrying the sentence.
   *
   * Each is keyed by the package it is installed as (`@acme/feature-tests:
   * standoff`, `FeatureKey`), as the engine keys the feature's scene
   * objects when the package's module evaluates (`FeatureNamespaces`); the
   * manifest keeps the plain id. Two packages' features never share a key.
   */
  private static packageEntries(offer: PackageOffer): FeatureCatalogEntry[] {
    const pkg: PackageRef = { name: offer.name, version: offer.version, availability: offer.availability };
    return offer.manifest.features.map(feature => ({
      id: FeatureKey.of(offer.name, feature.id),
      exportName: feature.exportName,
      modulePath: normalizePath(`${offer.directory}/${feature.module}`),
      builtIn: false,
      meta: { ...feature.meta, id: FeatureKey.of(offer.name, feature.id) },
      usesOcct: feature.usesOcct === true,
      package: pkg,
      ...(offer.problem !== undefined ? { error: offer.problem } : {}),
    }));
  }

  /** Every entry whose id another entry shares, refused with a message naming both. */
  private static markSharedIds(entries: FeatureCatalogEntry[]): FeatureCatalogEntry[] {
    const byId = new Map<string, FeatureCatalogEntry[]>();
    for (const entry of entries) {
      if (entry.id !== null) {
        byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
      }
    }
    return entries.map(entry => {
      const sharing = entry.id === null ? [] : byId.get(entry.id)!;
      if (sharing.length < 2) {
        return entry;
      }
      const where = sharing.map(e => `${e.exportName} (${e.builtIn ? e.modulePath : e.modulePath.split('/').pop()})`).join(', ');
      return {
        ...entry,
        error: `the feature id '${entry.id}' is used by more than one builder: ${where} — give each feature its own id, and export it from one module`,
      };
    });
  }
}
