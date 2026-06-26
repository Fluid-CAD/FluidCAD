import * as fs from "fs";
import { join, resolve, sep } from "path";
import { Shape } from "../common/shape.js";
import { OcIO } from "../oc/io.js";
import { getSceneManager } from "../scene-manager.js";
import { Solid } from "../common/solid.js";

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

  static importFile(workspacePath: string, fileName: string, data: Uint8Array): Solid[] {
    console.log(`Importing file: ${fileName}, size: ${data.length} bytes`);

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

    cleanup();

    console.log(`Imported ${solids.length} solids with color metadata`);
    return solids;
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
