import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import JSZip from 'jszip';
import { normalizePath } from '../normalize-path.ts';
import { isScriptPath, readDeclaredUnit } from '../file-unit.ts';
import {
  readProjectConfig,
  type LengthUnit,
  type PackageInfo,
  type ProjectConfig,
} from '../project-config.ts';
import { FluidCadServer } from '../fluidcad-server/index.ts';
import { FeatureModules } from '../feature-catalog/walk.ts';
import { RawOcctUse } from '../feature-catalog/raw-occt.ts';
import type { FeatureScanResult } from '../feature-catalog/scan.ts';
import type { PartScanResult } from '../part-catalog/scan.ts';
import { listFeatureAssets } from '../../../lib/dist/index.js';
import { SDK_VERSION } from '../../../lib/dist/sdk/version.js';
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
import { PackageName } from './package-name.ts';
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
  /** The manifest's `createdAt`; now when omitted. */
  createdAt?: string;
  /** The engine to evaluate with. Omitted, one is booted in process over the workspace and closed after. */
  engine?: PackEngine;
};

export type PackPackageResult = {
  manifest: PackageManifest;
  zip: Buffer;
  /** Every file of the archive by its path, `manifest.json` included: the installed tree, byte for byte. */
  files: Record<string, Buffer>;
};

/** A refusal to pack, worded for the author: one sentence that names the file. */
export class PackageBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageBuildError';
  }
}

/** What one evaluated export module offers. */
type ModuleExports = {
  module: string;
  features: Omit<PackageManifestFeature, 'usesOcct'>[];
  parts: PackageManifestPart[];
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
 * archive holds the sources verbatim — the closure of the declared
 * exports, the images their features declare, and the README, LICENSE and
 * CHANGELOG — plus three generated files at its root: `index.js` (named
 * re-exports), a reduced `fluidcad.json` (`unit`, `materials`) and
 * `manifest.json`.
 *
 * Every check is a refusal ({@link PackageBuildError}) naming the file:
 * 1. the `package` block is valid and every export exists;
 * 2. every export module evaluates in the engine;
 * 3. no name is exported twice, and every feature id starts with the scope (K4);
 * 4. every exported part and assembly builds with its defaults, no object in error;
 * 5. the closure stays inside the workspace: no `node_modules`, `init.js`,
 *    blocked built-in or other package, and nothing on a reserved root path;
 * 6. every image a feature declares exists inside its module's directory;
 * 7. raw OpenCascade use is recorded per feature (not a refusal).
 */
export class PackageBuilder {
  /** Root files that ship when present, matched without regard to case. */
  private static readonly EXTRAS = [/^readme\.md$/i, /^licen[cs]e(\..*)?$/i, /^changelog\.md$/i];

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
        throw new PackageBuildError(`${problems[key]} Fix it, then pack again.`);
      }
    }
    if (!config.package) {
      throw new PackageBuildError(PackageAuthoring.NOT_A_PACKAGE);
    }
    for (const key of ['engine', 'unit', 'materials'] as const) {
      if (problems[key]) {
        throw new PackageBuildError(`${problems[key]} Fix it, then pack again.`);
      }
    }
    return config.package;
  }

  private async build(): Promise<PackPackageResult> {
    this.checkExportsExist();
    const closure = await this.closure();
    this.checkLiveBuffers(closure);

    const evaluated = this.inputs.engine
      ? await this.evaluate(this.inputs.engine)
      // Pack writes nothing to the workspace, not even the engine's courtesy link.
      : await InProcessEngine.run(this.workspace, (engine) => this.evaluate(engine.server), { linkEngine: false });
    this.checkNames(evaluated);

    const features = await this.withRawOcct(evaluated);
    const assets = this.assets(features);
    const extras = await this.extras();
    const shipped = [...new Set([...closure, ...assets, ...extras])].sort();
    return this.archive(shipped, features, evaluated.flatMap((m) => m.parts));
  }

  // ---------------------------------------------------------------------------
  // Check 1: the exports
  // ---------------------------------------------------------------------------

  private checkExportsExist(): void {
    for (const rel of this.info.exports) {
      const abs = join(this.workspace, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        throw new PackageBuildError(
          `"exports" lists ${rel}, which doesn't exist in the workspace. Fix the path, or remove it from "exports".`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Check 5: the closure
  // ---------------------------------------------------------------------------

  /** The workspace-relative files the exports import, transitively, themselves included. */
  private async closure(): Promise<string[]> {
    let closure: ModuleClosure;
    try {
      closure = await ModuleClosure.of(this.workspace, {
        entries: this.info.exports.map((rel) => `./${rel}`),
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
    }
    return closure.files;
  }

  /** A file that would land on one of the archive's generated root files. */
  private checkNotReserved(rel: string, why: string): void {
    if (PackageLayout.isReserved(rel)) {
      throw new PackageBuildError(
        `${rel} would ship at the package root (${why}), where pack writes its own generated ${rel}. Rename or move it.`,
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
        throw new PackageBuildError(`${rel} has unsaved changes: save it, then pack again.`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Checks 2 and 4: evaluate every export module, build every part
  // ---------------------------------------------------------------------------

  private async evaluate(engine: PackEngine): Promise<ModuleExports[]> {
    const missing = engine.describeMissingEngine();
    if (missing) {
      throw new PackageBuildError(missing);
    }
    const unit = this.config.unit ?? 'mm';
    const modules: ModuleExports[] = [];
    for (const rel of [...this.info.exports].sort()) {
      const abs = normalizePath(join(this.workspace, rel));
      const entry: ModuleExports = { module: rel, features: [], parts: [] };
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
      });
    }
    return parts;
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
    const scope = PackageName.scope(this.info.name)!;
    const byId = new Map<string, string>();
    for (const feature of modules.flatMap((m) => m.features)) {
      if (!feature.id.startsWith(`${scope}.`)) {
        throw new PackageBuildError(
          `${feature.module} declares the feature id '${feature.id}', but ${this.info.name} may only declare ids ` +
            `that start with '${scope}.' (the package's scope).`,
        );
      }
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
  // Checks 6 and 7: images and raw OpenCascade
  // ---------------------------------------------------------------------------

  private async withRawOcct(modules: ModuleExports[]): Promise<PackageManifestFeature[]> {
    const features: PackageManifestFeature[] = [];
    for (const module of modules) {
      if (module.features.length === 0) {
        continue;
      }
      const { usesOcct } = await RawOcctUse.scan(join(this.workspace, module.module), this.workspace);
      features.push(...module.features.map((f) => ({ ...f, usesOcct })));
    }
    return features;
  }

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
  // The generated files and the archive
  // ---------------------------------------------------------------------------

  private async archive(
    shipped: string[],
    features: PackageManifestFeature[],
    parts: PackageManifestPart[],
  ): Promise<PackPackageResult> {
    const files: Record<string, Buffer> = {};
    for (const rel of shipped) {
      files[rel] = await readFile(join(this.workspace, rel));
    }
    files[PackageLayout.ENTRY] = Buffer.from(this.entrySource(features, parts));
    files[PackageLayout.CONFIG] = Buffer.from(this.reducedConfig());
    const manifest = await this.manifest(files, features, parts);
    files[PackageLayout.MANIFEST] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');

    const zip = new JSZip();
    const date = new Date(manifest.createdAt);
    for (const rel of Object.keys(files).sort()) {
      zip.file(rel, files[rel], { date });
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    return { manifest, zip: buffer, files };
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
      minEngine: info.minEngine
        ?? (Semver.isValid(this.config.engine) ? this.config.engine : this.inputs.fluidcadVersion),
      sdkVersion: SDK_VERSION,
      unit: this.config.unit ?? 'mm',
      fileUnits: await PackageBuilder.fileUnits(files),
      contents,
      features: [...features].sort((a, b) => PackageBuilder.byModuleThenName(a, b)),
      parts: [...parts].sort((a, b) => PackageBuilder.byModuleThenName(a, b)),
      files: Object.keys(files).sort(),
      createdAt: this.inputs.createdAt ?? new Date().toISOString(),
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
