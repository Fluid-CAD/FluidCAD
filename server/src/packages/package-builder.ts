import { readFileSync, realpathSync, statSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import JSZip from 'jszip';
import { normalizePath } from '../normalize-path.ts';
import { isScriptPath, readDeclaredUnit } from '../file-unit.ts';
import { RenderAssets } from '../files/render-assets.ts';
import {
  readProjectConfig,
  type LengthUnit,
  type PackageInfo,
  type ProjectConfig,
} from '../project-config.ts';
import { FluidCadServer } from '../fluidcad-server/index.ts';
import { FeatureModules } from '../feature-catalog/walk.ts';
import type { FeatureScanResult } from '../feature-catalog/scan.ts';
import type { CatalogConfiguration, PartScanResult } from '../part-catalog/scan.ts';
import { FeatureDocs, listFeatureAssets, type DocGap } from '../../../lib/dist/index.js';
import { SDK_SINCE, SDK_VERSION } from '../../../lib/dist/sdk/version.js';
import { DocLinks } from './doc-links.ts';
import { EsbuildPlugins } from './esbuild-plugins.ts';
import { InProcessEngine } from './in-process-engine.ts';
import { ModuleClosure } from './module-closure.ts';
import { PackageAuthoring } from './package-authoring.ts';
import {
  PackageLayout,
  type PackageManifest,
  type PackageManifestFeature,
  type PackageManifestPart,
} from './package-manifest.ts';
import { Semver } from './semver.ts';

/**
 * The slice of an engine the packer evaluates a package's exports with.
 * `FluidCadServer` is one: the open workspace's running engine packs
 * through it (`POST /api/pack`), and the CLI boots an
 * {@link InProcessEngine} for it.
 */
export interface PackEngine {
  /** Why nothing can be evaluated (no `init.js`), or null. */
  describeMissingEngine(): string | null;
  scanFeaturesInFile(filePath: string): Promise<FeatureScanResult | null>;
  scanPartsInFile(filePath: string, projectUnit?: LengthUnit): Promise<PartScanResult | null>;
  /** An editor buffer overlaying a file: the engine evaluates it instead of the disk, which is what ships. */
  getLiveBuffer?(filePath: string): string | null;
}

export type PackPackageInputs = {
  workspacePath: string;
  /** The packing engine's version: the manifest's `engine`, and the last fallback for `minEngine`. */
  fluidcadVersion: string;
  /** The engine to evaluate with. Omitted, one is booted in process over the workspace and closed after. */
  engine?: PackEngine;
};

export type PackPackageResult = {
  manifest: PackageManifest;
  zip: Buffer;
  /** Every file of the archive by its path, `manifest.json` included: the installed tree, byte for byte. */
  files: Record<string, Buffer>;
  /** What the author should look at; never a refusal, and never in the archive ({@link PackWarning}). */
  warnings: PackWarning[];
};

/**
 * What kind of warning a {@link PackWarning} is (package-docs DOC5, DOC6):
 * - `undocumented-fields`: a module's feature values, features, or part and
 *   assembly parameters without a useful description (`FeatureDocs`), one
 *   warning per module;
 * - `docs-link`: a relative link or image in a doc page that leads to no
 *   shipped file, or out of the package, one warning per link.
 */
export type PackWarningCode = 'undocumented-fields' | 'docs-link';

/** Something pack noticed but packs anyway: the CLI prints it under the summary, `--json` and the MCP `pack` carry it. */
export type PackWarning = {
  code: PackWarningCode;
  /** The file it is about: the module, or the page that holds the link. */
  file: string;
  /** One sentence naming the file, for the author. */
  message: string;
  /** `docs-link`: the link as written, and its 1-based line. */
  target?: string;
  line?: number;
  /** `undocumented-fields`: the fields, in the module's order. */
  fields?: DocGap[];
};

/**
 * What kind of refusal a {@link PackageBuildError} is. The layout's own
 * (HD20, and `docs/`'s, DOC6) have codes the hub shares; every other check
 * is `refused`.
 * - `no-exports`: nothing in `features/`, `parts/` or `assemblies/`;
 * - `wrong-folder`: a module whose suffix belongs in another of the three;
 * - `outside-layout`: a shipped module outside the three folders, or a script in `docs/`;
 * - `docs-file`: a file in `docs/` that is neither a markdown page nor an image;
 * - `docs-too-large`: a doc page, a doc image or the whole of `docs/` over its cap.
 * Two more name what the author must do before packing again, for a page
 * that offers the step (the Publish dialog, ui-packages-plan N3/N4):
 * - `not-a-package`: the workspace has no `package` block;
 * - `bad-config`: `fluidcad.json` can't be read, or its block, pin, unit or materials are broken;
 * - `unsaved-changes`: a shipped file whose editor buffer differs from the disk (a running engine packs).
 */
export type PackageBuildErrorCode = 'refused' | 'no-exports' | 'wrong-folder' | 'outside-layout' | 'docs-file' | 'docs-too-large' | 'not-a-package' | 'bad-config' | 'unsaved-changes';

/** A refusal to pack, worded for the author: one sentence that names the file. */
export class PackageBuildError extends Error {
  constructor(message: string, readonly code: PackageBuildErrorCode = 'refused') {
    super(message);
    this.name = 'PackageBuildError';
  }
}

/**
 * A file the engine read while an export module's parts built
 * (`PartScanResult.moduleAssets`, `ScannedPart.assets`): absolute, as the
 * engine named it, and the part or assembly whose build read it — null when
 * the module read it as it evaluated.
 */
type ReadAsset = { path: string; reader: string | null };

/** What one evaluated export module offers, and the files its parts read as they built. */
type ModuleExports = {
  module: string;
  features: PackageManifestFeature[];
  parts: PackageManifestPart[];
  assets: ReadAsset[];
};

/**
 * Pack the workspace's package (`fluidcad.json` `package`) into a
 * `.fluidpkg` (research §2). Never writes to the workspace: the caller
 * writes the archive where it wants.
 */
export async function packPackage(inputs: PackPackageInputs): Promise<PackPackageResult> {
  return PackageBuilder.pack(inputs);
}

/**
 * Builds a package archive from a package workspace (research §2). The
 * exports are what the `features/`, `parts/` and `assemblies/` folders
 * hold ({@link PackageLayout.exportsOf}, HD20). The archive holds the
 * sources verbatim — the exports' closure, the images their features
 * declare, the files the exported parts and assemblies read as they build
 * (a `load()`'s `imports/` geometry, a `text()`'s font file), the README,
 * LICENSE and CHANGELOG, and the `docs/` folder's pages and images — plus
 * three generated files at its root: `index.js` (named re-exports), a
 * reduced `fluidcad.json` (`unit`, `materials`) and `manifest.json`. A
 * workspace without `docs/` packs exactly as it did before `docs/` shipped,
 * and one whose parts read no files exactly as it did before they shipped.
 *
 * Every check is a refusal ({@link PackageBuildError}) naming the file:
 * 1. the `package` block is valid, and its `minEngine` is no older than
 *    the first FluidCAD of the SDK it is packed against (`SDK_SINCE`); no
 *    module sits in the wrong folder for its suffix (`wrong-folder`), and
 *    the folders hold something to export (`no-exports`);
 * 2. every export module evaluates in the engine;
 * 3. no name is exported twice, and no feature id is declared twice (ids are plain, keyed by the package at load);
 * 4. every exported part and assembly builds with its defaults, no object in error;
 * 5. the closure stays inside the workspace: no `node_modules`, `init.js`,
 *    blocked built-in or other package, nothing on a reserved root path,
 *    and nothing outside the three folders (`outside-layout`);
 * 6. every image a feature declares exists inside its module's directory;
 * 7. `docs/` holds only markdown pages and the images they show (a script
 *    is `outside-layout`, anything else `docs-file`), none of them leading
 *    outside the workspace, a page at most 256 KB, an image at most 2 MB, and
 *    the folder at most 4 MB and 200 files (`docs-too-large`);
 * 8. every file an exported part or assembly reads as it builds (check 4)
 *    that no import shows — a `load()`'s `imports/<name>.brep` and its
 *    `.colors.json` and `.import.json` sidecars, a `text()`'s workspace font
 *    file — lies inside the workspace: not in `node_modules`, not outside it
 *    through a link or a `..`, and not on a reserved root path. Each ships at
 *    its workspace path, outside the three folders too (`imports/` sits at
 *    the root), as the engine reads it there ({@link PackageLayout}'s
 *    assets). They are what the builds read, not a scan of the source or of
 *    `imports/`: an import no part loads stays home, and a sidecar the
 *    engine looked for and did not find is no refusal.
 *
 * Nothing is refused for missing documentation (DOC4). Two things are
 * warned about instead ({@link PackWarning}), and the package still packs:
 * fields without a useful description (`undocumented-fields`, the
 * `FeatureDocs` rule), and doc links that lead nowhere (`docs-link`).
 */
export class PackageBuilder {
  /** Root files that ship when present, matched without regard to case. */
  private static readonly EXTRAS = [/^readme\.md$/i, /^licen[cs]e(\..*)?$/i, /^changelog\.md$/i];
  /**
   * The date every zip entry carries: the zip format's epoch, never the
   * clock. Nothing in an archive depends on when it was packed, so the same
   * tree packs to the same bytes and the same tree hash.
   */
  private static readonly ENTRY_DATE = new Date('1980-01-01T00:00:00.000Z');

  private constructor(
    private readonly workspace: string,
    private readonly config: ProjectConfig,
    private readonly info: PackageInfo,
    private readonly inputs: PackPackageInputs,
  ) {}

  static async pack(inputs: PackPackageInputs): Promise<PackPackageResult> {
    const workspace = PackageBuilder.canonical(inputs.workspacePath);
    const config = readProjectConfig(workspace);
    const builder = new PackageBuilder(workspace, config, PackageBuilder.packageOf(config), inputs);
    return builder.build();
  }

  /**
   * The workspace's validated `package` block. Refuses a plain project, and
   * a `fluidcad.json` whose block, unit, materials or engine pin is broken:
   * the archive's unit and materials come from it, and a broken one would
   * ship as mm with no materials.
   */
  static packageOf(config: ProjectConfig): PackageInfo {
    const problems = config.problems ?? {};
    for (const key of ['file', 'package'] as const) {
      if (problems[key]) {
        throw new PackageBuildError(`${problems[key]} Fix it, then try again.`, 'bad-config');
      }
    }
    if (!config.package) {
      throw new PackageBuildError(PackageAuthoring.NOT_A_PACKAGE, 'not-a-package');
    }
    for (const key of ['engine', 'unit', 'materials'] as const) {
      if (problems[key]) {
        throw new PackageBuildError(`${problems[key]} Fix it, then try again.`, 'bad-config');
      }
    }
    return config.package;
  }

  private async build(): Promise<PackPackageResult> {
    this.checkMinEngine();
    const exports = this.exports();
    const closure = await this.closure(exports);
    this.checkLiveBuffers(closure);
    const docs = this.docs();

    const evaluated = this.inputs.engine
      ? await this.evaluate(this.inputs.engine, exports)
      // Pack writes nothing to the workspace, not even the engine's courtesy link.
      : await InProcessEngine.run(this.workspace, (engine) => this.evaluate(engine.server, exports), { linkEngine: false });
    this.checkNames(evaluated);

    const features = evaluated.flatMap((m) => m.features);
    const assets = this.assets(features);
    const read = this.readAssets(evaluated);
    const extras = await this.extras();
    const shipped = [...new Set([...closure, ...assets, ...read, ...extras, ...docs])].sort();
    const result = await this.archive(shipped, features, evaluated.flatMap((m) => m.parts));
    return { ...result, warnings: [...this.undocumented(evaluated), ...this.docLinks(result.files)] };
  }

  // ---------------------------------------------------------------------------
  // Check 1: the block's engine floor, the layout and the exports
  // ---------------------------------------------------------------------------

  /**
   * The lowest engine the package supports, and where that came from: the
   * block's `minEngine`, else the workspace's engine pin, else the packing
   * engine.
   */
  private minEngine(): { version: string; from: 'block' | 'pin' | 'engine' } {
    if (this.info.minEngine !== undefined) {
      return { version: this.info.minEngine, from: 'block' };
    }
    if (Semver.isValid(this.config.engine)) {
      return { version: this.config.engine, from: 'pin' };
    }
    return { version: this.inputs.fluidcadVersion, from: 'engine' };
  }

  /**
   * A package packed against feature SDK N runs on no FluidCAD older than
   * SDK N's first one (`SDK_SINCE`), so a `minEngine` below it would claim
   * engines that can't load it, and an incompatible package would read
   * "Requires FluidCAD 0.0.40+" on a FluidCAD it can't run on either
   * (hub-plan H11 decision 3). Refused before anything is evaluated.
   */
  private checkMinEngine(): void {
    const { version, from } = this.minEngine();
    const floor = Semver.parse(SDK_SINCE);
    const declared = Semver.parse(version);
    if (!floor || !declared || Semver.compare(declared, floor) >= 0) {
      return;
    }
    const where = from === 'block'
      ? `its "minEngine" ${version} (fluidcad.json's package block)`
      : from === 'pin'
        ? `its minEngine ${version} (taken from fluidcad.json's "engine" pin, as the package block sets none)`
        : `its minEngine ${version} (this FluidCAD's version)`;
    throw new PackageBuildError(
      `${this.info.name} can't declare ${where}: it is packed against feature SDK ${SDK_VERSION}, which FluidCAD ${SDK_SINCE} ` +
        `introduced, so no older FluidCAD can load it. Set "minEngine" in the package block to ${SDK_SINCE} or later, then try again.`,
    );
  }

  /** What the three folders export, refused when a module sits in the wrong one or none holds anything. */
  private exports(): string[] {
    const [misplaced] = PackageLayout.misplacedIn(this.workspace);
    if (misplaced) {
      throw new PackageBuildError(PackageLayout.describeMisplaced(misplaced), 'wrong-folder');
    }
    const exports = PackageLayout.exportsOf(this.workspace);
    if (exports.length === 0) {
      throw new PackageBuildError(
        `${this.info.name} exports nothing: put its feature modules in features/, its parts in parts/ and ` +
          'its assemblies in assemblies/. A package exports what those folders hold.',
        'no-exports',
      );
    }
    return exports;
  }

  // ---------------------------------------------------------------------------
  // Check 5: the closure
  // ---------------------------------------------------------------------------

  /** The workspace-relative files the exports import, transitively, themselves included. */
  private async closure(exports: string[]): Promise<string[]> {
    let closure: ModuleClosure;
    try {
      closure = await ModuleClosure.of(this.workspace, {
        entries: exports.map((rel) => `./${rel}`),
        wrapperName: '__package_exports__.js',
        plugins: [EsbuildPlugins.refusePackageImports()],
      });
    } catch (err: any) {
      throw new PackageBuildError(PackageBuilder.describeEsbuildFailure(err));
    }
    for (const rel of closure.files) {
      const importer = closure.importersOf(rel)[0] ?? null;
      const by = importer ? `${importer} imports ${rel}` : `${rel}`;
      if (ModuleClosure.isOutsideWorkspace(rel)) {
        throw new PackageBuildError(`${by}, which lies outside the workspace: a package ships only its own files.`);
      }
      if (ModuleClosure.isInNodeModules(rel)) {
        throw new PackageBuildError(`${by}, an npm dependency: a package can't carry npm dependencies yet.`);
      }
      if (rel === 'init.js') {
        throw new PackageBuildError(
          `${by}, which never ships: the engine that loads a package boots itself. Move what the module needs out of init.js.`,
        );
      }
      this.checkNotReserved(rel, importer ? `${importer} imports it` : 'it is exported');
      if (PackageLayout.folderOf(rel) === null) {
        throw new PackageBuildError(
          `${by}, which is outside ${PackageLayout.describeFolders()}: a package ships only what those folders hold. ` +
            `Move ${rel} into one of them.`,
          'outside-layout',
        );
      }
    }
    return closure.files;
  }

  /** A file that would land on one of the archive's generated root files. */
  private checkNotReserved(rel: string, why: string): void {
    if (PackageLayout.isReserved(rel)) {
      throw new PackageBuildError(
        `${rel} would ship at the package root (${why}), where the archive has its own generated ${rel}. Rename or move it.`,
      );
    }
  }

  /** esbuild's resolution errors as one sentence per error, each naming its file and line. */
  private static describeEsbuildFailure(err: any): string {
    const errors: any[] = Array.isArray(err?.errors) ? err.errors : [];
    if (errors.length === 0) {
      return err?.message ?? String(err);
    }
    return errors.map((e) => {
      const where = e.location ? `${normalizePath(e.location.file)}:${e.location.line}: ` : '';
      return `${where}${e.text}`;
    }).join('\n');
  }

  /**
   * A running engine evaluates a file's editor buffer, while the archive
   * ships the disk: refuse rather than check one text and ship another.
   */
  private checkLiveBuffers(closure: string[]): void {
    const engine = this.inputs.engine;
    if (!engine?.getLiveBuffer) {
      return;
    }
    for (const rel of closure) {
      const abs = normalizePath(join(this.workspace, rel));
      const buffer = engine.getLiveBuffer(abs);
      if (buffer === null || buffer === undefined) {
        continue;
      }
      let disk: string | null = null;
      try {
        disk = readFileSync(abs, 'utf8');
      } catch {
        disk = null;
      }
      if (disk !== buffer) {
        throw new PackageBuildError(`${rel} has unsaved changes: save it, then pack again.`, 'unsaved-changes');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Checks 2 and 4: evaluate every export module, build every part
  // ---------------------------------------------------------------------------

  private async evaluate(engine: PackEngine, exports: string[]): Promise<ModuleExports[]> {
    const missing = engine.describeMissingEngine();
    if (missing) {
      throw new PackageBuildError(missing);
    }
    const unit = this.config.unit ?? 'mm';
    const modules: ModuleExports[] = [];
    for (const rel of exports) {
      const abs = normalizePath(join(this.workspace, rel));
      const entry: ModuleExports = { module: rel, features: [], parts: [], assets: [] };
      if (!rel.endsWith('.assembly.js')) {
        const scan = await engine.scanFeaturesInFile(abs);
        if (scan === null) {
          throw new PackageBuildError(engine.describeMissingEngine() ?? 'The engine did not start.');
        }
        if (scan.error !== undefined) {
          throw new PackageBuildError(`${rel} doesn't evaluate: ${scan.error}`);
        }
        entry.features = scan.features.map((f) => ({ id: f.meta.id, exportName: f.exportName, module: rel, meta: f.meta }));
      }
      if (!FeatureModules.isModule(rel)) {
        const scan = await engine.scanPartsInFile(abs, unit);
        if (scan === null) {
          throw new PackageBuildError(engine.describeMissingEngine() ?? 'The engine did not start.');
        }
        entry.parts = this.partsOf(rel, scan, new Set(entry.features.map((f) => f.exportName)));
        entry.assets = PackageBuilder.readsOf(scan);
      }
      if (entry.features.length === 0 && entry.parts.length === 0) {
        throw new PackageBuildError(
          `${rel} exports nothing a package can share: export its feature builders, parts or assemblies by name.`,
        );
      }
      modules.push(entry);
    }
    return modules;
  }

  /** One part module's parts and assemblies, refused when any fails to build with its defaults. */
  private partsOf(rel: string, scan: PartScanResult, featureNames: Set<string>): PackageManifestPart[] {
    for (const error of scan.errors) {
      if (error.exportName === null) {
        throw new PackageBuildError(`${rel} doesn't evaluate: ${error.message}`);
      }
      // The part scan calls every function export; a feature builder isn't a part.
      if (featureNames.has(error.exportName)) {
        continue;
      }
      throw new PackageBuildError(
        `${rel}: '${error.exportName}' doesn't build with its default parameters: ${error.message}`,
      );
    }
    const parts: PackageManifestPart[] = [];
    for (const part of scan.parts) {
      this.checkObjects(rel, part.exportName, part.objects);
      parts.push({
        exportName: part.exportName,
        module: rel,
        name: part.partName,
        kind: 'part',
        exportKind: part.kind,
        params: part.params,
        ...PackageBuilder.configurationsOf(part.configurations),
      });
    }
    for (const assembly of scan.assemblies) {
      this.checkObjects(rel, assembly.exportName, assembly.objects);
      parts.push({
        exportName: assembly.exportName,
        module: rel,
        name: assembly.assemblyName ?? assembly.exportName,
        kind: 'assembly',
        exportKind: assembly.exportKind,
        params: assembly.params,
        ...PackageBuilder.configurationsOf(assembly.configurations),
      });
    }
    return parts;
  }

  /** What a scanned module read as it evaluated, and what each of its parts and assemblies read as it built. */
  private static readsOf(scan: PartScanResult): ReadAsset[] {
    const reads = (paths: string[] | undefined, reader: string | null) => (paths ?? []).map((path) => ({ path, reader }));
    return [
      ...reads(scan.moduleAssets, null),
      ...scan.parts.flatMap((part) => reads(part.assets, part.exportName)),
      ...scan.assemblies.flatMap((assembly) => reads(assembly.assets, assembly.exportName)),
    ];
  }

  /** The manifest's `configurations` field for a scanned definition: its rows as declared, left out when it has none. */
  private static configurationsOf(rows: CatalogConfiguration[] | undefined): Pick<PackageManifestPart, 'configurations'> {
    if (!rows || rows.length === 0) {
      return {};
    }
    return { configurations: rows.map((row) => ({ name: row.name, values: { ...row.values } })) };
  }

  /** A part's rendered objects, refused at the first that failed to build: shape counts alone hide a failure. */
  private checkObjects(rel: string, exportName: string, objects: any[]): void {
    const [first] = FluidCadServer.collectObjectErrors(objects);
    if (first) {
      throw new PackageBuildError(
        `${rel}: '${exportName}' doesn't build with its default parameters: ` +
          `its ${first.name ?? first.uniqueKind ?? 'object'} fails (${first.message})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 3: names and ids
  // ---------------------------------------------------------------------------

  private checkNames(modules: ModuleExports[]): void {
    const byName = new Map<string, string>();
    for (const module of modules) {
      for (const name of [...module.features.map((f) => f.exportName), ...module.parts.map((p) => p.exportName)]) {
        const other = byName.get(name);
        if (other !== undefined) {
          throw new PackageBuildError(
            `${other} and ${module.module} both export '${name}': the package entry re-exports by name, so rename one of them.`,
          );
        }
        byName.set(name, module.module);
      }
    }
    // Ids are plain (no scope prefix): a consumer's engine keys them by this
    // package's name at load (`@acme/kit:standoff`), so they only have to be
    // unique in here.
    const byId = new Map<string, string>();
    for (const feature of modules.flatMap((m) => m.features)) {
      const other = byId.get(feature.id);
      if (other !== undefined) {
        throw new PackageBuildError(
          `${other} and ${feature.module} both declare the feature id '${feature.id}': give each feature its own id.`,
        );
      }
      byId.set(feature.id, feature.module);
    }
  }

  // ---------------------------------------------------------------------------
  // Check 6: images
  // ---------------------------------------------------------------------------

  /** Every image the features declare, workspace-relative; each must exist inside its module's directory. */
  private assets(features: PackageManifestFeature[]): string[] {
    const out: string[] = [];
    for (const feature of features) {
      const directory = dirname(join(this.workspace, feature.module));
      for (const asset of listFeatureAssets(feature.meta)) {
        const abs = resolve(directory, asset);
        const where = `${feature.module} declares the image ${asset} (feature '${feature.id}')`;
        let realDirectory: string;
        let realFile: string;
        try {
          realDirectory = realpathSync(directory);
          realFile = realpathSync(abs);
        } catch {
          throw new PackageBuildError(`${where}, which doesn't exist next to the module.`);
        }
        if (!realFile.startsWith(realDirectory + sep) || !statSync(realFile).isFile()) {
          throw new PackageBuildError(`${where}, which leads outside the module's directory.`);
        }
        const rel = normalizePath(relative(this.workspace, abs));
        this.checkNotReserved(rel, `${feature.module} declares it`);
        out.push(rel);
      }
    }
    return out;
  }

  /** The README, LICENSE and CHANGELOG at the workspace root, when present. */
  private async extras(): Promise<string[]> {
    const entries = await readdir(this.workspace, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && PackageBuilder.EXTRAS.some((pattern) => pattern.test(e.name)))
      .map((e) => e.name);
  }

  // ---------------------------------------------------------------------------
  // Check 7: docs/
  // ---------------------------------------------------------------------------

  /** Every file under `docs/`, workspace-relative and sorted: pages and images only, each within its cap, and the folder within its own. */
  private docs(): string[] {
    const files = PackageLayout.docsIn(this.workspace);
    let realWorkspace: string;
    try {
      realWorkspace = realpathSync(this.workspace);
    } catch {
      realWorkspace = this.workspace;
    }
    let bytes = 0;
    for (const rel of files) {
      if (PackageLayout.isScript(rel)) {
        throw new PackageBuildError(PackageLayout.describeOutsideLayout(rel), 'outside-layout');
      }
      if (!PackageLayout.isDocPage(rel) && !PackageLayout.isDocImage(rel)) {
        throw new PackageBuildError(PackageLayout.describeDocsFile(rel), 'docs-file');
      }
      // A linked page or image ships its target's bytes: it must be the workspace's own.
      const real = realpathSync(join(this.workspace, rel));
      if (!real.startsWith(realWorkspace + sep)) {
        throw new PackageBuildError(`${rel} links to a file outside the workspace: a package ships only its own files.`);
      }
      const size = statSync(real).size;
      const cap = PackageLayout.isDocPage(rel) ? PackageLayout.DOCS_PAGE_BYTES : PackageLayout.DOCS_IMAGE_BYTES;
      if (size > cap) {
        throw new PackageBuildError(PackageLayout.describeDocsFileTooLarge(rel, size), 'docs-too-large');
      }
      bytes += size;
    }
    if (files.length > PackageLayout.DOCS_FILES || bytes > PackageLayout.DOCS_BYTES) {
      throw new PackageBuildError(PackageLayout.describeDocsFolderTooLarge(files.length, bytes), 'docs-too-large');
    }
    return files;
  }

  // ---------------------------------------------------------------------------
  // Check 8: the files the parts read as they build
  // ---------------------------------------------------------------------------

  /**
   * Every file the exported parts and assemblies read as they built that
   * no import shows, workspace-relative ({@link RenderAssets.locate}): one
   * that does not exist is skipped, one beyond the workspace or in
   * `node_modules` refused, naming the module and the part that read it.
   */
  private readAssets(modules: ModuleExports[]): string[] {
    const out = new Set<string>();
    for (const module of modules) {
      for (const asset of module.assets) {
        const location = RenderAssets.locate(asset.path, this.workspace);
        const reader = asset.reader === null ? module.module : `${module.module}: '${asset.reader}'`;
        switch (location.kind) {
          case 'missing':
            break;
          case 'outside':
            throw new PackageBuildError(`${reader} reads ${this.describeOutside(asset.path)}: a package ships only its own files.`);
          case 'node-modules':
            throw new PackageBuildError(
              `${reader} reads ${location.path}, which lies in node_modules: a package ships only its own files. ` +
                'Copy it into the workspace and read the copy.',
            );
          case 'workspace':
            this.checkNotReserved(location.path, `${reader} reads it`);
            out.add(location.path);
            break;
        }
      }
    }
    return [...out];
  }

  /**
   * A file read from beyond the workspace, for a sentence: by its workspace
   * path when the engine read it under the workspace (a link leads out),
   * else by its absolute path. The engine's root may be the workspace as
   * given or as the filesystem names it; either counts.
   */
  private describeOutside(assetAbs: string): string {
    const named = normalizePath(assetAbs);
    for (const root of new Set([this.workspace, normalizePath(resolve(this.inputs.workspacePath))])) {
      const rel = normalizePath(relative(root, named));
      if (!ModuleClosure.isOutsideWorkspace(rel) && !isAbsolute(rel)) {
        return `${rel}, which links to a file outside the workspace`;
      }
    }
    return `${named}, which lies outside the workspace`;
  }

  // ---------------------------------------------------------------------------
  // The warnings
  // ---------------------------------------------------------------------------

  /** Each module's fields without a useful description (`FeatureDocs`): one warning per module, in module order. */
  private undocumented(modules: ModuleExports[]): PackWarning[] {
    const out: PackWarning[] = [];
    for (const module of modules) {
      const fields = [
        ...module.features.flatMap((f) => FeatureDocs.missing(f.meta, f.exportName)),
        ...module.parts.flatMap((p) => FeatureDocs.missingParams(p.params ?? [], p.exportName)),
      ];
      if (fields.length > 0) {
        out.push({ code: 'undocumented-fields', file: module.module, message: FeatureDocs.describe(fields, module.module), fields });
      }
    }
    return out;
  }

  /** Each relative link or image in a doc page that leads to no file of the archive, or out of the package. */
  private docLinks(files: Record<string, Buffer>): PackWarning[] {
    const out: PackWarning[] = [];
    for (const page of Object.keys(files).sort()) {
      if (!PackageLayout.isDocPage(page)) {
        continue;
      }
      for (const link of DocLinks.scan(files[page].toString('utf8'))) {
        const target = DocLinks.resolve(page, link.target);
        if (target === null || (target.kind === 'file' && files[target.path] !== undefined)) {
          continue;
        }
        const where = target.kind === 'outside' ? 'which leads outside the package' : 'which leads to no file the package ships';
        out.push({
          code: 'docs-link',
          file: page,
          message: `${page}:${link.line} links to ${link.target}, ${where}.`,
          target: link.target,
          line: link.line,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The generated files and the archive
  // ---------------------------------------------------------------------------

  private async archive(
    shipped: string[],
    features: PackageManifestFeature[],
    parts: PackageManifestPart[],
  ): Promise<Omit<PackPackageResult, 'warnings'>> {
    const files: Record<string, Buffer> = {};
    for (const rel of shipped) {
      files[rel] = await readFile(join(this.workspace, rel));
    }
    files[PackageLayout.ENTRY] = Buffer.from(this.entrySource(features, parts));
    files[PackageLayout.CONFIG] = Buffer.from(this.reducedConfig());
    const manifest = await this.manifest(files, features, parts);
    files[PackageLayout.MANIFEST] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');

    // Folder entries are added here, dated like the files: JSZip's own
    // (`createFolders`) would be dated by the clock.
    const zip = new JSZip();
    const date = PackageBuilder.ENTRY_DATE;
    for (const rel of Object.keys(files).sort()) {
      for (const folder of PackageBuilder.folders(rel)) {
        if (zip.files[folder] === undefined) {
          zip.file(folder, null, { dir: true, date, createFolders: false });
        }
      }
      zip.file(rel, files[rel], { date, createFolders: false });
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    return { manifest, zip: buffer, files };
  }

  /** The folders above an archive path, outermost first: `a/b/c.js` → `a/`, `a/b/`. */
  private static folders(rel: string): string[] {
    const parts = rel.split('/').slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
  }

  /** `index.js`: one named re-export line per module, modules and names sorted. */
  private entrySource(features: PackageManifestFeature[], parts: PackageManifestPart[]): string {
    const byModule = new Map<string, string[]>();
    for (const { module, exportName } of [...features, ...parts]) {
      byModule.set(module, [...(byModule.get(module) ?? []), exportName]);
    }
    const lines = [...byModule.keys()].sort().map((module) => {
      const names = byModule.get(module)!.sort().join(', ');
      return `export { ${names} } from ${JSON.stringify(`./${module}`)};`;
    });
    return [
      `// Generated by \`fluidcad pack\`: every feature, part and assembly ${this.info.name} exports, by name.`,
      ...lines,
      '',
    ].join('\n');
  }

  /** The package root's `fluidcad.json`: the unit made explicit, and the project's materials. */
  private reducedConfig(): string {
    const reduced = {
      unit: this.config.unit ?? 'mm',
      ...(this.config.materials !== null ? { materials: this.config.materials } : {}),
    };
    return JSON.stringify(reduced, null, 2) + '\n';
  }

  private async manifest(
    files: Record<string, Buffer>,
    features: PackageManifestFeature[],
    parts: PackageManifestPart[],
  ): Promise<PackageManifest> {
    const info = this.info;
    const optional: Partial<PackageManifest> = {};
    for (const key of ['description', 'license', 'author', 'homepage', 'keywords'] as const) {
      if (info[key] !== undefined) {
        (optional as any)[key] = info[key];
      }
    }
    const contents: PackageManifest['contents'] = [];
    if (features.length > 0) {
      contents.push('features');
    }
    if (parts.length > 0) {
      contents.push('parts');
    }
    return {
      manifestVersion: PackageLayout.MANIFEST_VERSION,
      name: info.name,
      version: info.version,
      ...optional,
      engine: this.inputs.fluidcadVersion,
      minEngine: this.minEngine().version,
      sdkVersion: SDK_VERSION,
      unit: this.config.unit ?? 'mm',
      fileUnits: await PackageBuilder.fileUnits(files),
      contents,
      features: [...features].sort((a, b) => PackageBuilder.byModuleThenName(a, b)),
      parts: [...parts].sort((a, b) => PackageBuilder.byModuleThenName(a, b)),
      files: Object.keys(files).sort(),
    };
  }

  /** Every shipped script's `unit()` declaration, read statically. */
  private static async fileUnits(files: Record<string, Buffer>): Promise<Record<string, LengthUnit>> {
    const units: Record<string, LengthUnit> = {};
    for (const rel of Object.keys(files).sort()) {
      if (!isScriptPath(rel)) {
        continue;
      }
      const unit = await readDeclaredUnit(files[rel].toString('utf8'));
      if (unit) {
        units[rel] = unit;
      }
    }
    return units;
  }

  private static byModuleThenName(a: { module: string; exportName: string }, b: { module: string; exportName: string }): number {
    return a.module === b.module
      ? (a.exportName < b.exportName ? -1 : a.exportName > b.exportName ? 1 : 0)
      : (a.module < b.module ? -1 : 1);
  }

  /** The workspace as the filesystem names it, so esbuild's realpath'd inputs stay relative to it. */
  private static canonical(workspacePath: string): string {
    try {
      return normalizePath(realpathSync(workspacePath));
    } catch {
      return normalizePath(workspacePath);
    }
  }
}
