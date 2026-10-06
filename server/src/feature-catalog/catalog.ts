import { realpathSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { getJavaScriptParser, namedImportBindings, type NamedImportBinding, type TSTree } from '../code-editor/index.ts';
import {
  CustomFeatureStatement,
  FeatureCallees,
  type CustomFeatureCallee,
  type FeatureCalleeSource,
} from '../apply-feature-edit/index.ts';
import { ScanCache } from '../part-catalog/cache.ts';
import { listFeatureAssets, type FeatureMetaSnapshot } from '../../../lib/dist/index.js';
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
  /** The feature's id (`acme.standoff`); null for a module that did not evaluate. */
  id: string | null;
  /** The name the builder is imported by; null for a module that did not evaluate. */
  exportName: string | null;
  /** The module's absolute path, or `fluidcad/core` for a built-in. */
  modulePath: string;
  builtIn: boolean;
  meta: FeatureMetaSnapshot | null;
  /**
   * The feature's module — or a workspace module it imports — reaches raw
   * OpenCascade (`fluidcad/sdk/occt`, or a scope opened with `this.occ()`;
   * see {@link RawOcctUse}): unstable code that can corrupt the kernel's
   * memory for the whole engine session. Read from the source, never
   * evaluated. False for the engine's own builders.
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
 * metadata. Module scans are cached by the mtimes of everything the module
 * imported.
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
   * Every feature, built-ins first, then each module in path order; null
   * while the engine is not up. An id two builders share marks both
   * entries with an error — which one a statement means would depend on
   * the walk order, and the id is what the timeline and the cache key on.
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
    return FeatureCatalog.markSharedIds(entries);
  }

  /**
   * The feature a call to `calleeName` builds in `filePath`: the file's
   * import of that name, followed to the module it names and matched
   * against the module's exports — so an alias (`import { standoff as so }`)
   * resolves `so`. Null for a name the file declares itself, imports from
   * anything but a feature module or `fluidcad/core`, or that names no
   * feature there.
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
    for (const [local, binding] of namedImportBindings(tree)) {
      const entry = await this.entryFor(binding, filePath);
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
   * one a cached module imports, or an image a scanned feature declares
   * (its metadata stands, but the page must fetch the image again).
   */
  noteFileChange(absPath: string): boolean {
    const file = normalizePath(absPath);
    const dropped = this.cache.dropDependents(file);
    return FeatureModules.isModule(file) || dropped || this.declaresAsset(file);
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
  private async entryFor(binding: NamedImportBinding, filePath: string): Promise<FeatureCatalogEntry | null> {
    const modulePath = this.moduleOf(binding.source, filePath);
    if (modulePath === null) {
      return null;
    }
    const entries = modulePath === FeatureCatalog.BUILT_IN_MODULE
      ? await this.builtIns()
      : await this.moduleEntries(modulePath);
    return entries?.find(entry => entry.exportName === binding.imported && entry.meta !== null) ?? null;
  }

  /**
   * The catalog module an import specifier names from `filePath`: a
   * relative specifier resolved to a feature module inside the workspace,
   * or the engine's core entry (either spelling the editor writes it in).
   */
  private moduleOf(source: string, filePath: string): string | null {
    if (source === 'fluidcad/core' || source === 'fluidcad') {
      return FeatureCatalog.BUILT_IN_MODULE;
    }
    if (!this.workspacePath || !(source.startsWith('./') || source.startsWith('../'))) {
      return null;
    }
    const absPath = normalizePath(resolve(dirname(normalizePath(filePath)), source));
    if (!FeatureModules.isModule(absPath) || !absPath.startsWith(this.workspacePath + '/')) {
      return null;
    }
    return absPath;
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
