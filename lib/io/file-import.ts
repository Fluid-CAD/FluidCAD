import * as fs from "fs";
import { join, resolve, sep } from "path";
import { Shape } from "../common/shape.js";
import { OcIO } from "../oc/io.js";
import { getSceneManager } from "../scene-manager.js";
import { Solid } from "../common/solid.js";
import { isLengthUnit } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import type { StepFileUnits } from "../oc/step-units.js";

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
 * (e.g. `imports/foo.brep`). Returning null falls back to disk.
 */
export type AssetProvider = (workspaceRelPath: string) => Uint8Array | null;

let assetProvider: AssetProvider | null = null;

export function setAssetProvider(provider: AssetProvider | null): void {
  assetProvider = provider;
}

function readWorkspaceAsset(relPath: string): { text: string; exists: true } | { exists: false } {
  if (assetProvider) {
    const bytes = assetProvider(relPath);
    if (bytes) {
      return { text: Buffer.from(bytes).toString('utf8'), exists: true };
    }
  }
  const sceneManager = getSceneManager();
  const filePath = join(sceneManager!.rootPath, relPath);
  if (!fs.existsSync(filePath)) {
    return { exists: false };
  }
  return { text: fs.readFileSync(filePath, 'utf8'), exists: true };
}

/**
 * Reads a workspace asset as raw bytes (e.g. a font file). Consults the
 * AssetProvider first (hub mode), then the workspace filesystem. Paths are
 * workspace-relative and confined to the workspace root (no `..` traversal).
 * Returns null when the asset cannot be found.
 */
export function readWorkspaceAssetBytes(relPath: string): Uint8Array | null {
  if (assetProvider) {
    const bytes = assetProvider(relPath);
    if (bytes) {
      return bytes;
    }
  }
  const sceneManager = getSceneManager();
  if (!sceneManager) {
    return null;
  }
  const root = resolve(sceneManager.rootPath);
  const filePath = resolve(root, relPath);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath);
}

export class FileImport {
  static deserializeShapes(fileName: string): Solid[] {
    if (!fileName.endsWith(('.brep'))) {
      fileName += '.brep';
    }

    const relPath = join('imports', fileName);

    console.log(`Reading file ${fileName}`);
    const result = readWorkspaceAsset(relPath);
    if (!result.exists) {
      throw new Error(`Imported asset not found: ${relPath}`);
    }
    console.log(`File ${relPath} read successfully, size: ${result.text.length} bytes`);

    return OcIO.readBRepSolids(fileName, result.text);
  }

  static serializeShape(shape: Shape, workspacePath: string, fileName: string) {
    const file = OcIO.writeBRep(shape, fileName);

    console.log(`Writing file ${fileName} to actual filesystem at ${workspacePath}`);
    fs.writeFileSync(
      join(workspacePath, 'imports', fileName.replace(/.(step|stp)$/i, '.brep')),
      file);
  }

  static importFile(workspacePath: string, fileName: string, data: Uint8Array): ImportFileResult {
    console.log(`Importing file: ${fileName}, size: ${data.length} bytes`);

    const sourceUnits = OcIO.readStepFileUnits(data);
    const { docHandle, cleanup } = OcIO.readStepXCAF(fileName, data);

    const { solids: solidEntries } = OcIO.extractSolidsAndColors(docHandle);

    const solids: Solid[] = [];
    const colorData: SolidColorData[] = [];

    for (const entry of solidEntries) {
      const solid = entry.shape;
      const faces = OcIO.findFaces(solid);

      for (const fc of entry.faceColors) {
        if (fc.faceIndex < faces.length) {
          solid.setColor(faces[fc.faceIndex].getShape(), fc.color);
        }
      }

      solids.push(solid);
      colorData.push({ faces: entry.faceColors });
    }

    // Serialize all solids as compound .brep
    const brepFileName = fileName.replace(/\.(step|stp)$/i, '.brep');
    const brepContent = OcIO.writeSolidsAsBRep(solids, brepFileName);
    fs.writeFileSync(join(workspacePath, 'imports', brepFileName), brepContent);

    // Write color metadata as JSON sidecar
    const jsonFileName = fileName.replace(/\.(step|stp)$/i, '.colors.json');
    const jsonPath = join(workspacePath, 'imports', jsonFileName);
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
    const metaPath = join(workspacePath, 'imports', fileName.replace(/\.(step|stp)$/i, '.import.json'));
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    cleanup();

    console.log(`Imported ${solids.length} solids with color metadata (file units: ${sourceUnits.length.join(', ') || 'undeclared'})`);
    return { solids, unit: 'mm', sourceUnits };
  }

  /** The `<name>.import.json` sidecar, or null when the asset has none (or it is unreadable). */
  static readImportMeta(fileName: string): ImportMeta | null {
    const baseName = fileName.replace(/\.(step|stp|brep)$/i, '');
    const result = readWorkspaceAsset(join('imports', baseName + '.import.json'));
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
  static readAssetUnit(fileName: string): LengthUnit {
    const meta = FileImport.readImportMeta(fileName);
    if (meta && isLengthUnit(meta.unit)) {
      return meta.unit;
    }
    return 'mm';
  }

  static deserializeShapesWithMetadata(
    fileName: string,
    options?: { noColors?: boolean; include?: Set<number>; exclude?: Set<number> },
  ): Solid[] {
    // Read geometry from .brep
    const brepFileName = fileName.replace(/\.(step|stp|brep)$/i, '');
    const shapes = FileImport.deserializeShapes(brepFileName);

    // Read color metadata from JSON sidecar (skipped when noColors is set)
    let colorData: SolidColorData[] = [];
    if (!options?.noColors) {
      const relPath = join('imports', brepFileName + '.colors.json');
      const result = readWorkspaceAsset(relPath);
      if (result.exists) {
        colorData = JSON.parse(result.text);
        console.log(`Loaded color metadata from ${relPath}`);
      }
    }

    const include = options?.include;
    const exclude = options?.exclude;

    // Build Solid objects, filter by original index, and apply colors by face index.
    const solids: Solid[] = [];
    for (let solidIndex = 0; solidIndex < shapes.length; solidIndex++) {
      if (include && !include.has(solidIndex)) {
        continue;
      }
      if (exclude && exclude.has(solidIndex)) {
        continue;
      }

      const solid = shapes[solidIndex];
      const solidColors = colorData[solidIndex];
      if (solidColors) {
        const faces = OcIO.findFaces(solid);
        for (const entry of solidColors.faces) {
          if (entry.faceIndex < faces.length) {
            solid.setColor(faces[entry.faceIndex].getShape(), entry.color);
          }
        }
      }

      solids.push(solid);
    }

    console.log(`Deserialized ${solids.length} solids with color metadata`);
    return solids;
  }

}

interface SolidColorData {
  faces: Array<{ faceIndex: number; color: string }>;
}
