import * as fs from "fs";
import { join } from "path";
import { Shape } from "../common/shape.js";
import { OcIO, type ImportedBodyKind, type ImportedFaceColor } from "../oc/io.js";
import type { ColoredBody, FaceColor } from "../common/colored-body.js";
import { getSceneManager } from "../scene-manager.js";
import { isLengthUnit } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import type { StepFileUnits } from "../oc/step-units.js";
import { AssetRoots, type AssetRoot } from "./asset-roots.js";
import { describeImportContents, type ImportContents } from "./import-contents.js";

export type { ImportContents } from "./import-contents.js";

/**
 * Sidecar written next to an imported `.brep` (`<name>.import.json`). It is
 * separate from `.colors.json` (a bare array indexed by body) so readers of
 * that file keep working. `unit` is the unit the cached geometry is in —
 * always mm, because the STEP reader converts into mm — and `sourceUnits`
 * are the names the source file declared. `contents` counts what the cache
 * holds; an asset imported before it was recorded has none.
 */
export interface ImportMeta {
  schemaVersion: 1;
  unit: LengthUnit;
  sourceUnits: StepFileUnits;
  importedAt: string;
  contents?: ImportContents;
}

/** One body of an imported asset, in body order, and what it is to the user. */
export interface ImportedAssetBody {
  shape: Shape;
  kind: ImportedBodyKind;
}

export interface ImportFileResult {
  /** The bodies, in body order: solids, then surfaces, then curves. */
  bodies: ImportedAssetBody[];
  contents: ImportContents;
  /** The unit the cached geometry is in. */
  unit: LengthUnit;
  /** What the source STEP file declared, for the import report. */
  sourceUnits: StepFileUnits;
}

/**
 * Override hook for hub mode (and tests). When set, asset reads consult
 * the provider instead of the filesystem — paths are workspace-relative
 * (e.g. `imports/foo.brep`), an installed package's under its root's key
 * (`packages/@acme/kit/1.2.0/imports/foo.brep`). Returning null falls back
 * to disk.
 */
export type AssetProvider = (workspaceRelPath: string) => Uint8Array | null;

let assetProvider: AssetProvider | null = null;

export function setAssetProvider(provider: AssetProvider | null): void {
  assetProvider = provider;
}

/**
 * The workspace's `imports/` folder, created on first use. A fresh project
 * has no such folder, and every import writer below lands its cache there.
 */
function ensureImportsDir(workspacePath: string): string {
  const dir = join(workspacePath, 'imports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export class FileImport {
  /**
   * The bodies of an imported asset's `.brep` cache, in body order, read
   * under `root` (the workspace for null). A missing one is an error that
   * names where it was looked for — never a read of another root's file of
   * the same name.
   */
  static deserializeShapes(fileName: string, root: AssetRoot | null = null): Shape[] {
    if (!fileName.endsWith(('.brep'))) {
      fileName += '.brep';
    }

    const relPath = FileImport.workspacePath(join('imports', fileName));

    console.log(`Reading file ${fileName}`);
    const result = FileImport.readAssetText(relPath, root);
    if (!result.exists) {
      throw new Error(root
        ? AssetRoots.describeMissing('Imported asset not found', relPath, root, "load(name, { from: 'project' })")
        : `Imported asset not found: ${relPath}`);
    }
    console.log(`File ${relPath} read successfully, size: ${result.text.length} bytes`);

    return OcIO.readBRepBodies(fileName, result.text);
  }

  static serializeShape(shape: Shape, workspacePath: string, fileName: string) {
    const file = OcIO.writeBRep(shape, fileName);

    console.log(`Writing file ${fileName} to actual filesystem at ${workspacePath}`);
    fs.writeFileSync(
      join(ensureImportsDir(workspacePath), fileName.replace(/\.(step|stp)$/i, '.brep')),
      file);
  }

  /**
   * Imports a STEP file into the workspace's `imports/` cache: its solids,
   * its surfaces (shells outside solids, loose faces) and its curves (wires
   * outside faces, loose edges), in body order, with the face colours of
   * solids and surfaces. Anything else the file holds (points, meshes,
   * annotations) is not imported.
   */
  static importFile(workspacePath: string, fileName: string, data: Uint8Array): ImportFileResult {
    console.log(`Importing file: ${fileName}, size: ${data.length} bytes`);

    const sourceUnits = OcIO.readStepFileUnits(data);
    const { docHandle, cleanup } = OcIO.readStepXCAF(fileName, data);

    let entries: ReturnType<typeof OcIO.extractBodiesAndColors>['bodies'];
    try {
      entries = OcIO.extractBodiesAndColors(docHandle).bodies;
    } finally {
      cleanup();
    }

    const bodies: ImportedAssetBody[] = [];
    const colorData: BodyColorData[] = [];
    const contents: ImportContents = { solids: 0, surfaces: 0, curves: 0 };

    // Geometry goes to the .brep, colours to the sidecar by face index: the
    // asset carries them apart, and `load` records them on itself. A curve's
    // entry is empty, so the sidecar stays indexed by body.
    for (const entry of entries) {
      bodies.push({ shape: entry.shape, kind: entry.kind });
      colorData.push({ faces: entry.faceColors });
      contents[CONTENTS_KEY[entry.kind]]++;
    }

    const importsDir = ensureImportsDir(workspacePath);
    const brepFileName = fileName.replace(/\.(step|stp)$/i, '.brep');
    const brepContent = OcIO.writeBodiesAsBRep(bodies.map(b => b.shape), brepFileName);
    fs.writeFileSync(join(importsDir, brepFileName), brepContent);

    const jsonFileName = fileName.replace(/\.(step|stp)$/i, '.colors.json');
    const jsonPath = join(importsDir, jsonFileName);
    fs.writeFileSync(jsonPath, JSON.stringify(colorData, null, 2));
    console.log(`Written color metadata to ${jsonPath}`);

    // The reader converts every file unit into mm, so the cache is mm
    // whatever the source declared; load() scales into the loading document.
    const meta: ImportMeta = {
      schemaVersion: 1,
      unit: 'mm',
      sourceUnits,
      importedAt: new Date().toISOString(),
      contents,
    };
    const metaPath = join(importsDir, fileName.replace(/\.(step|stp)$/i, '.import.json'));
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`Imported ${describeImportContents(contents) ?? 'nothing'} with color metadata (file units: ${sourceUnits.length.join(', ') || 'undeclared'})`);
    return { bodies, contents, unit: 'mm', sourceUnits };
  }

  /**
   * Reads an asset as text: from the asset provider under the root's key
   * ({@link providerKey}), else from disk under the root's directory — the
   * workspace for null. Paths are relative in any spelling
   * ({@link workspacePath}) and confined to the root: one that leads out of
   * it is refused ({@link leavesRoot}).
   */
  static readAssetText(relPath: string, root: AssetRoot | null = null): { text: string; exists: true } | { exists: false } {
    relPath = FileImport.confined(relPath, root);
    const key = FileImport.providerKey(relPath, root);
    if (assetProvider && key !== null) {
      const bytes = assetProvider(key);
      if (bytes) {
        // Not Node's Buffer: a viewer's engine reads its share link's assets
        // here, in a browser worker that has none.
        return { text: new TextDecoder().decode(bytes), exists: true };
      }
    }
    const filePath = join(root ? root.dir : getSceneManager()!.rootPath, relPath);
    if (!fs.existsSync(filePath)) {
      return { exists: false };
    }
    return { text: fs.readFileSync(filePath, 'utf8'), exists: true };
  }

  /**
   * Reads an asset as raw bytes (e.g. a font file), as {@link readAssetText}
   * reads it: the asset provider first, then disk under the root (the
   * workspace for null). A path leading out of the root is refused. Returns
   * null when the asset cannot be found.
   */
  static readAssetBytes(relPath: string, root: AssetRoot | null = null): Uint8Array | null {
    relPath = FileImport.confined(relPath, root);
    const key = FileImport.providerKey(relPath, root);
    if (assetProvider && key !== null) {
      const bytes = assetProvider(key);
      if (bytes) {
        return bytes;
      }
    }
    const base = root ? root.dir : getSceneManager()?.rootPath;
    if (base === undefined) {
      return null;
    }
    const filePath = join(base, relPath);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath);
  }

  /**
   * Whether a relative asset path ({@link workspacePath}'s spelling) leads
   * out of the root it is read under: an absolute path, a drive, or `..`
   * segments climbing above the root. A `..` that stays inside is fine.
   * Read off the path alone, so a provider's tree is confined as the disk is.
   */
  static leavesRoot(relPath: string): boolean {
    if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
      return true;
    }
    let depth = 0;
    for (const segment of relPath.split('/')) {
      if (segment === '..') {
        depth--;
        if (depth < 0) {
          return true;
        }
      } else {
        depth++;
      }
    }
    return false;
  }

  /** `relPath` in {@link workspacePath}'s spelling, refused when it leads out of the root. */
  private static confined(relPath: string, root: AssetRoot | null): string {
    const normalized = FileImport.workspacePath(relPath);
    if (FileImport.leavesRoot(normalized)) {
      throw new Error(`Asset path ${normalized} leads outside ${AssetRoots.describe(root)}`);
    }
    return normalized;
  }

  /**
   * The path the asset provider is asked for: the workspace-relative path,
   * under the root's key for an installed package — null when no provider's
   * tree carries the package (a library package), which is then read from
   * disk alone.
   */
  private static providerKey(relPath: string, root: AssetRoot | null): string | null {
    if (!root) {
      return relPath;
    }
    return root.key === null ? null : `${root.key.replace(/\/+$/, '')}/${relPath}`;
  }

  /**
   * A workspace-relative asset path as the asset provider and the render's
   * inputs key it: forward slashes, no `.` segments or doubled slashes, so
   * `./fonts/Brand.ttf` and `fonts\Brand.ttf` are both `fonts/Brand.ttf` —
   * the path a share link's tree carries the file under. `..` segments are
   * left as written.
   */
  static workspacePath(relPath: string): string {
    const slashed = relPath.trim().replace(/\\/g, '/');
    const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.');
    return (slashed.startsWith('/') ? '/' : '') + segments.join('/');
  }

  /**
   * The on-disk identity of an imported asset — the `.brep` cache and its
   * sidecars under `root` (the workspace for null) — as {@link diskStamp}
   * takes it. A load() compares it, so a re-imported asset rebuilds instead
   * of matching the previous render's geometry.
   */
  static assetStamp(fileName: string, root: AssetRoot | null = null): string | null {
    const baseName = fileName.replace(/\.(step|stp|brep)$/i, '');
    return FileImport.diskStamp(['.brep', '.colors.json', '.import.json'].map((suffix) => join('imports', baseName + suffix)), root);
  }

  /**
   * The on-disk identity of files a statement reads under `root` — an
   * installed package's directory, the workspace for null — mtime + size
   * each, `-` for a missing one, and the note to the scene manager that
   * this render depends on them, missing or not, by absolute path. A
   * statement takes it when it is constructed, which every render does (a
   * build the scene compare reuses never reads its files again), and
   * compares it, so a file changed on disk rebuilds the statement. The
   * render's inputs are what a share link carries beside the source, and
   * what the server's render fingerprint stats, a package's files included.
   * A path leading out of the root is no input (its read is refused). Null
   * when assets do not come from the filesystem (a packed bundle or a share
   * link's tree, which never change under a running scene).
   */
  static diskStamp(relPaths: readonly string[], root: AssetRoot | null = null): string | null {
    const sceneManager = getSceneManager();
    if (assetProvider || !sceneManager) {
      return null;
    }
    const base = root ? root.dir : sceneManager.rootPath;
    const stamps: string[] = [];
    for (const relPath of relPaths) {
      const normalized = FileImport.workspacePath(relPath);
      if (FileImport.leavesRoot(normalized)) {
        stamps.push('-');
        continue;
      }
      const filePath = join(base, normalized);
      sceneManager.recordRenderInput(filePath);
      try {
        const stats = fs.statSync(filePath);
        stamps.push(`${stats.mtimeMs}:${stats.size}`);
      } catch {
        stamps.push('-');
      }
    }
    return stamps.join('|');
  }

  /** The `<name>.import.json` sidecar under `root` (the workspace for null), or null when the asset has none (or it is unreadable). */
  static readImportMeta(fileName: string, root: AssetRoot | null = null): ImportMeta | null {
    const baseName = fileName.replace(/\.(step|stp|brep)$/i, '');
    const result = FileImport.readAssetText(join('imports', baseName + '.import.json'), root);
    if (!result.exists) {
      return null;
    }
    try {
      const parsed = JSON.parse(result.text);
      if (parsed && typeof parsed === 'object') {
        return parsed as ImportMeta;
      }
    } catch (err) {
      console.warn(`Ignoring unreadable import sidecar for ${baseName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  /**
   * The unit an imported asset's cached geometry is in. Assets without a
   * sidecar (imported before units existed, or copied in by hand) are mm:
   * that is what the STEP reader has always produced.
   */
  static readAssetUnit(fileName: string, root: AssetRoot | null = null): LengthUnit {
    const meta = FileImport.readImportMeta(fileName, root);
    if (meta && isLengthUnit(meta.unit)) {
      return meta.unit;
    }
    return 'mm';
  }

  /**
   * The asset's bodies — solids, surfaces and curves, in body order — with
   * the sidecar's colours resolved to their faces (none with `noColors`),
   * read under `options.root` (the workspace for none). `include` and
   * `exclude` name bodies by their index in that order. The caller (`load`)
   * holds the bodies and records the colours as its own paint.
   */
  static deserializeShapesWithMetadata(
    fileName: string,
    options?: { noColors?: boolean; include?: Set<number>; exclude?: Set<number>; root?: AssetRoot | null },
  ): ColoredBody[] {
    const root = options?.root ?? null;
    const brepFileName = fileName.replace(/\.(step|stp|brep)$/i, '');
    const shapes = FileImport.deserializeShapes(brepFileName, root);

    let colorData: BodyColorData[] = [];
    if (!options?.noColors) {
      const relPath = join('imports', brepFileName + '.colors.json');
      const result = FileImport.readAssetText(relPath, root);
      if (result.exists) {
        colorData = JSON.parse(result.text);
        console.log(`Loaded color metadata from ${relPath}`);
      }
    }

    const include = options?.include;
    const exclude = options?.exclude;

    const bodies: ColoredBody[] = [];
    for (let bodyIndex = 0; bodyIndex < shapes.length; bodyIndex++) {
      const body = shapes[bodyIndex];
      if ((include && !include.has(bodyIndex)) || (exclude && exclude.has(bodyIndex))) {
        // A body left out is never handed on: its kernel memory goes now.
        body.dispose();
        continue;
      }

      const colors: FaceColor[] = [];
      const bodyColors = colorData[bodyIndex];
      if (bodyColors && bodyColors.faces.length > 0) {
        const faces = OcIO.findFaces(body);
        for (const entry of bodyColors.faces) {
          if (entry.faceIndex < faces.length) {
            colors.push({ face: faces[entry.faceIndex], color: entry.color });
          }
        }
      }

      bodies.push({ body, colors });
    }

    console.log(`Deserialized ${bodies.length} bodies with color metadata`);
    return bodies;
  }

}

/** The `contents` counter each kind of body adds to. */
const CONTENTS_KEY: Record<ImportedBodyKind, keyof ImportContents> = {
  solid: 'solids',
  surface: 'surfaces',
  curve: 'curves',
};

/** One body's entry in the `.colors.json` sidecar. */
interface BodyColorData {
  faces: ImportedFaceColor[];
}
