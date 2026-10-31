import * as fs from "fs";
import { join } from "path";
import { Shape } from "../common/shape.js";
import { OcIO } from "../oc/io.js";
import type { ColoredSolid, FaceColor } from "../common/colored-solid.js";
import { getSceneManager } from "../scene-manager.js";
import { Solid } from "../common/solid.js";
import { isLengthUnit } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import type { StepFileUnits } from "../oc/step-units.js";
import { AssetRoots, type AssetRoot } from "./asset-roots.js";

/**
 * Sidecar written next to an imported `.brep` (`<name>.import.json`). It is
 * separate from `.colors.json` (a bare array that older readers index by
 * solid) so those readers keep working. `unit` is the unit the cached
 * geometry is in — always mm, because the STEP reader converts into mm —
 * and `sourceUnits` are the names the source file declared.
 */
export interface ImportMeta {
  schemaVersion: 1;
  unit: LengthUnit;
  sourceUnits: StepFileUnits;
  importedAt: string;
}

export interface ImportFileResult {
  solids: Solid[];
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
   * The solids of an imported asset's `.brep` cache, read under `root` (the
   * workspace for null). A missing one is an error that names where it was
   * looked for — never a read of another root's file of the same name.
   */
  static deserializeShapes(fileName: string, root: AssetRoot | null = null): Solid[] {
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

    return OcIO.readBRepSolids(fileName, result.text);
  }

  static serializeShape(shape: Shape, workspacePath: string, fileName: string) {
    const file = OcIO.writeBRep(shape, fileName);

    console.log(`Writing file ${fileName} to actual filesystem at ${workspacePath}`);
    fs.writeFileSync(
      join(ensureImportsDir(workspacePath), fileName.replace(/\.(step|stp)$/i, '.brep')),
      file);
  }

  static importFile(workspacePath: string, fileName: string, data: Uint8Array): ImportFileResult {
    console.log(`Importing file: ${fileName}, size: ${data.length} bytes`);

    const sourceUnits = OcIO.readStepFileUnits(data);
    const { docHandle, cleanup } = OcIO.readStepXCAF(fileName, data);

    const { solids: solidEntries } = OcIO.extractSolidsAndColors(docHandle);

    const solids: Solid[] = [];
    const colorData: SolidColorData[] = [];

    // Geometry goes to the .brep, colours to the sidecar by face index: the
    // asset carries them apart, and `load` records them on itself.
    for (const entry of solidEntries) {
      solids.push(entry.shape);
      colorData.push({ faces: entry.faceColors });
    }

    // Serialize all solids as compound .brep
    const importsDir = ensureImportsDir(workspacePath);
    const brepFileName = fileName.replace(/\.(step|stp)$/i, '.brep');
    const brepContent = OcIO.writeSolidsAsBRep(solids, brepFileName);
    fs.writeFileSync(join(importsDir, brepFileName), brepContent);

    // Write color metadata as JSON sidecar
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
    };
    const metaPath = join(importsDir, fileName.replace(/\.(step|stp)$/i, '.import.json'));
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    cleanup();

    console.log(`Imported ${solids.length} solids with color metadata (file units: ${sourceUnits.length.join(', ') || 'undeclared'})`);
    return { solids, unit: 'mm', sourceUnits };
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
   * The asset's solids with the sidecar's colours resolved to their faces
   * (none with `noColors`), read under `options.root` (the workspace for
   * none). The caller (`load`) holds the solids and records the colours as
   * its own paint.
   */
  static deserializeShapesWithMetadata(
    fileName: string,
    options?: { noColors?: boolean; include?: Set<number>; exclude?: Set<number>; root?: AssetRoot | null },
  ): ColoredSolid[] {
    const root = options?.root ?? null;
    // Read geometry from .brep
    const brepFileName = fileName.replace(/\.(step|stp|brep)$/i, '');
    const shapes = FileImport.deserializeShapes(brepFileName, root);

    // Read color metadata from JSON sidecar (skipped when noColors is set)
    let colorData: SolidColorData[] = [];
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

    // Build Solid objects, filter by original index, and resolve colors by face index.
    const solids: ColoredSolid[] = [];
    for (let solidIndex = 0; solidIndex < shapes.length; solidIndex++) {
      if (include && !include.has(solidIndex)) {
        continue;
      }
      if (exclude && exclude.has(solidIndex)) {
        continue;
      }

      const solid = shapes[solidIndex];
      const colors: FaceColor[] = [];
      const solidColors = colorData[solidIndex];
      if (solidColors) {
        const faces = OcIO.findFaces(solid);
        for (const entry of solidColors.faces) {
          if (entry.faceIndex < faces.length) {
            colors.push({ face: faces[entry.faceIndex], color: entry.color });
          }
        }
      }

      solids.push({ solid, colors });
    }

    console.log(`Deserialized ${solids.length} solids with color metadata`);
    return solids;
  }

}

interface SolidColorData {
  faces: Array<{ faceIndex: number; color: string }>;
}
