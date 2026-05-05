import * as fs from "fs";
import { join } from "path";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { OcIO } from "../oc/io.js";
import { getSceneManager } from "../scene-manager.js";
import { Solid } from "../common/solid.js";

export class FileImport {
  static deserializeShapes(fileName: string): Solid[] {
    if (!fileName.endsWith(('.brep'))) {
      fileName += '.brep';
    }

    const sceneManager = getSceneManager();
    const filePath = join(sceneManager.rootPath, 'imports', fileName);

    console.log(`Reading file ${fileName}`);
    const file = fs.readFileSync(filePath, 'utf8');
    console.log(`File ${filePath} read successfully, size: ${file.length} bytes`);

    return OcIO.readBRepSolids(fileName, file);
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
      const sceneManager = getSceneManager();
      const jsonPath = join(sceneManager.rootPath, 'imports', brepFileName + '.colors.json');
      if (fs.existsSync(jsonPath)) {
        colorData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        console.log(`Loaded color metadata from ${jsonPath}`);
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
