import { realpathSync, statSync } from 'fs';
import { basename, dirname, resolve, sep } from 'path';
import { normalizePath } from '../normalize-path.ts';
import {
  GeneratedSchemas,
  type GeneratedAssetBase,
  type GeneratedAssetModules,
  type GeneratedSchema,
} from '../../../lib/dist/index.js';

/** Each image a generated definition's schema declares, by the module it resolves against: the path as declared → the URL the page fetches it from. */
export type GeneratedAssetUrls = Record<GeneratedAssetBase, Record<string, string>>;

/**
 * What a generated definition's catalog entry carries beside the fields
 * every entry has (`ScannedPart`, `ScannedSubAssembly`): a `definePart` or
 * `defineAssembly` export. The UI never runs its code; it reads the schema.
 */
export type ScannedGeneratedFields = {
  definitionKind: 'generated';
  /** The definition's schema snapshot (`getSchema()`): its values by id, dialog, label, icon, connectors. */
  schema: GeneratedSchema;
  /** Where each image the schema declares is served ({@link GeneratedCatalog.assetUrl}), by the module it resolves against. */
  assetUrls: GeneratedAssetUrls;
  /**
   * The modules the schema's images resolve against, absolute (lib
   * `GeneratedAssetModules`): what the asset route and the packer resolve
   * them with. Null for a base the engine could not tell.
   */
  assetModules: GeneratedAssetModules;
};

/** Where one of a generated definition's images is, or why it can't be served. */
export type GeneratedAssetLookup = { file: string } | { status: number; error: string };

/**
 * A generated definition (lib `definePart` / `defineAssembly`) as the part
 * catalog lists it.
 *
 * The rules:
 * - **Read, never rendered.** The catalog lists a generated definition from
 *   its schema snapshot alone: building its default would cost a generator's
 *   whole layout and builds, and a scan scene that rendered one would take
 *   its parts out of the engine's generated-part cache and free them with
 *   the scan. Its tile shows its icon instead of a thumbnail. Only the
 *   packer asks for the render (`ScanOptions.renderGenerated`), to check
 *   that every definition builds with its defaults.
 * - **Images by module.** A schema's image paths resolve against two
 *   modules (lib `GeneratedAssetBase`): the definition's (its icon, its own
 *   layout's pictures) and the class's (the values' option pictures and
 *   asides, a borrowed dialog's). The page fetches each from
 *   `GET /api/part-catalog/asset` ({@link assetUrl}), which serves only a
 *   path the schema declares, under the base it declares it for.
 */
export class GeneratedCatalog {
  /** The route that serves a generated definition's images, as the page addresses it (relative, like the feature catalog's). */
  static readonly ASSET_ROUTE = 'api/part-catalog/asset';

  /** Whether `value` is a generated definition (lib `GeneratedSchemas.isGenerated`). */
  static isGenerated(value: unknown): boolean {
    return GeneratedSchemas.isGenerated(value);
  }

  /** The catalog fields of `definition`, exported as `exportName` from `file`. */
  static fieldsOf(definition: unknown, file: string, exportName: string): ScannedGeneratedFields {
    const schema = (definition as { getSchema(): GeneratedSchema }).getSchema();
    const modules = GeneratedSchemas.modulesOf(definition) ?? { definition: null, class: null };
    const assets = GeneratedSchemas.assetsOf(schema);
    const urls = (base: GeneratedAssetBase) =>
      Object.fromEntries(assets[base].map(path => [path, GeneratedCatalog.assetUrl(file, exportName, base, path)]));
    return {
      definitionKind: 'generated',
      schema,
      assetUrls: { definition: urls('definition'), class: urls('class') },
      assetModules: {
        definition: modules.definition !== null ? normalizePath(modules.definition) : null,
        class: modules.class !== null ? normalizePath(modules.class) : null,
      },
    };
  }

  /**
   * The URL one image of the definition `exportName` exports from `file`
   * is served at: `api/part-catalog/asset?file=…&export=…&base=…&path=…`,
   * `path` exactly as the schema declares it.
   */
  static assetUrl(file: string, exportName: string, base: GeneratedAssetBase, path: string): string {
    const query = new URLSearchParams({ file, export: exportName, base, path });
    return `${GeneratedCatalog.ASSET_ROUTE}?${query.toString()}`;
  }

  /** Whether `value` names one of the two image bases. */
  static isBase(value: unknown): value is GeneratedAssetBase {
    return value === 'definition' || value === 'class';
  }
}

/**
 * Finding a generated definition's declared image on disk, confined.
 *
 * The rules:
 * - `path` must be one the schema declares under `base`
 *   (`GeneratedSchemas.assetsOf`) — the route serves nothing else.
 * - It resolves against the base's module, and may climb out of that
 *   module's directory (`'../features/icons/gear.png'`, as `definePart`'s
 *   meta allows) — but never out of the **root that owns the module**: the
 *   installed package's directory for a package's module, the workspace for
 *   the workspace's own. Both sides are compared with their links resolved,
 *   so neither a `..` nor a link on disk leads beyond it.
 */
export class GeneratedAssets {

  /**
   * The file behind `path`, one of `entry`'s images under `base`.
   * `rootOf` answers the root a module may read images in (null: none —
   * a module outside every package and the workspace).
   */
  static locate(
    entry: Pick<ScannedGeneratedFields, 'schema' | 'assetModules'>,
    base: GeneratedAssetBase,
    path: string,
    rootOf: (module: string) => string | null,
  ): GeneratedAssetLookup {
    const label = entry.schema.label;
    if (!GeneratedSchemas.assetsOf(entry.schema)[base].includes(path)) {
      return { status: 404, error: `${label} declares no image '${path}' relative to its ${GeneratedAssets.describeBase(base)}` };
    }
    const module = entry.assetModules[base];
    if (module === null) {
      return { status: 404, error: `${label}: the engine can't tell which module the image '${path}' is relative to` };
    }
    const root = rootOf(module);
    if (root === null) {
      return { status: 403, error: `${label}: its ${GeneratedAssets.describeBase(base)} (${basename(module)}) lies outside the workspace and every installed package` };
    }
    return GeneratedAssets.resolveIn(module, path, root, label);
  }

  /**
   * `path` resolved against `module`, if it names an existing file inside
   * `root` once links are resolved; else why not (404 missing, 403 outside).
   */
  static resolveIn(module: string, path: string, root: string, label: string): GeneratedAssetLookup {
    let realRoot: string;
    let realFile: string;
    try {
      realRoot = realpathSync(root);
      realFile = realpathSync(resolve(dirname(module), path));
    } catch {
      return { status: 404, error: `${label}: the image '${path}' does not exist next to ${basename(module)}` };
    }
    if (!realFile.startsWith(realRoot + sep)) {
      return { status: 403, error: `${label}: the image '${path}' leads outside ${GeneratedAssets.describeRoot(root)}` };
    }
    try {
      if (!statSync(realFile).isFile()) {
        return { status: 404, error: `${label}: the image '${path}' is not a file` };
      }
    } catch {
      return { status: 404, error: `${label}: the image '${path}' does not exist next to ${basename(module)}` };
    }
    return { file: realFile };
  }

  /** Whether `file` lies inside `root` once both are read with their links resolved (a symlinked workspace names its files either way). */
  static isInside(file: string, root: string): boolean {
    try {
      const realRoot = realpathSync(root);
      const realDir = realpathSync(dirname(file));
      return realDir === realRoot || realDir.startsWith(realRoot + sep);
    } catch {
      return false;
    }
  }

  private static describeBase(base: GeneratedAssetBase): string {
    return base === 'definition' ? 'definition module' : "class's module";
  }

  private static describeRoot(root: string): string {
    return `its package or workspace (${basename(root)})`;
  }
}

/** One file the generated listing reads: where it is, how the page names it, its unit and its package. */
export type GeneratedListingFile = {
  absPath: string;
  /** Workspace-relative, or `@scope/name/<module>` for a package's file. */
  path: string;
  unit: string;
  package?: { name: string; version: string; availability: 'dependency' | 'library' };
};

/** The scan fields the listing reads of one entry (`ScannedPart` / `ScannedSubAssembly`). */
type ListedScanEntry = { exportName: string } & Partial<ScannedGeneratedFields>;

/**
 * One generated definition as the assembly toolbar's Custom dropdown lists
 * it (`GET /api/part-catalog/generated`): its file and export (what an
 * insert names), its kind, its schema and image URLs, the file's unit and
 * the package it comes from.
 */
export type GeneratedListingEntry = {
  file: string;
  path: string;
  exportName: string;
  kind: 'part' | 'assembly';
  schema: GeneratedSchema;
  assetUrls: GeneratedAssetUrls;
  unit: string;
  package?: GeneratedListingFile['package'];
};

/**
 * Every generated definition the project can insert, read off the part
 * catalog's scans (generated definitions are listed from their schemas,
 * never built: {@link GeneratedCatalog}).
 *
 * The rules:
 * - The files are the workspace's that call `definePart(` or
 *   `defineAssembly(`, then the packages' modules whose manifests list a
 *   generated definition — the project's pins, then the library's offers.
 * - A file that fails to scan is left out (its problems are the Insert
 *   dialog's to report), so one broken module never empties the dropdown.
 * - A library offer whose definition id the project already lists (its own
 *   module, a pinned package) is left out, as the feature catalog leaves
 *   out a library feature the project has: it is only an offer.
 * - Workspace files first, in path order, then the packages' in the order
 *   given; each file's parts before its assemblies, in export order.
 */
export class GeneratedListing {
  static async collect(
    files: readonly GeneratedListingFile[],
    scan: (file: GeneratedListingFile) => Promise<{ parts: ListedScanEntry[]; assemblies: ListedScanEntry[] } | null>,
  ): Promise<GeneratedListingEntry[]> {
    const listed: GeneratedListingEntry[] = [];
    for (const file of files) {
      let result: Awaited<ReturnType<typeof scan>>;
      try {
        result = await scan(file);
      } catch {
        continue;
      }
      if (result === null) {
        continue;
      }
      for (const [kind, entries] of [['part', result.parts], ['assembly', result.assemblies]] as const) {
        for (const entry of entries) {
          const listing = GeneratedListing.entryOf(file, kind, entry);
          if (listing !== null) {
            listed.push(listing);
          }
        }
      }
    }
    const owned = new Set(listed.filter(entry => entry.package?.availability !== 'library').map(entry => entry.schema.id));
    return listed.filter(entry => entry.package?.availability !== 'library' || !owned.has(entry.schema.id));
  }

  private static entryOf(file: GeneratedListingFile, kind: 'part' | 'assembly', entry: ListedScanEntry): GeneratedListingEntry | null {
    if (entry.definitionKind !== 'generated' || !entry.schema || !entry.assetUrls) {
      return null;
    }
    return {
      file: file.absPath,
      path: file.path,
      exportName: entry.exportName,
      kind,
      schema: entry.schema,
      assetUrls: entry.assetUrls,
      unit: file.unit,
      ...(file.package ? { package: file.package } : {}),
    };
  }
}
