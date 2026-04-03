import type { Handle_TDocStd_Document, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Face } from "../common/face.js";
import { ShapeFactory } from "../common/shape-factory.js";

export class OcIO {
  // Wrapper methods (public API for external callers)
  static readBRep(fileName: string, content: string): Shape {
    const raw = OcIO.readBRepRaw(fileName, content);
    return ShapeFactory.fromShape(raw);
  }

  static writeBRep(shape: Shape, fileName: string): string {
    return OcIO.writeBRepRaw(shape.getShape(), fileName);
  }

  static readStep(fileName: string, data: Uint8Array): Shape {
    const raw = OcIO.readStepRaw(fileName, data);
    return ShapeFactory.fromShape(raw);
  }

  static findSolids(shape: Shape): Solid[] {
    const oc = getOC();
    const rawSolids = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    return rawSolids.map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));
  }

  static findFaces(shape: Shape): Face[] {
    const oc = getOC();
    const rawFaces = Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE);
    return rawFaces.map(f => Face.fromTopoDSFace(Explorer.toFace(f)));
  }

  static makeCompound(shapes: Shape[]): Shape {
    const raw = OcIO.makeCompoundRaw(shapes.map(s => s.getShape()));
    return ShapeFactory.fromShape(raw);
  }

  static readBRepSolids(fileName: string, content: string): Solid[] {
    const raw = OcIO.readBRepRaw(fileName, content);
    if (Explorer.isSolid(raw)) {
      return [Solid.fromTopoDSSolid(Explorer.toSolid(raw))];
    }
    const oc = getOC();
    const rawSolids = Explorer.findShapes(raw, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    return rawSolids.map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));
  }

  static writeSolidsAsBRep(solids: Solid[], fileName: string): string {
    const compound = OcIO.makeCompoundRaw(solids.map(s => s.getShape()));
    return OcIO.writeBRepRaw(compound, fileName);
  }

  static extractSolidsAndColors(docHandle: Handle_TDocStd_Document): {
    solids: Array<{ shape: Solid; faceColors: Array<{ faceIndex: number; color: string }> }>;
  } {
    const rawResult = OcIO.extractSolidsAndColorsRaw(docHandle);
    return {
      solids: rawResult.solids.map(entry => ({
        shape: Solid.fromTopoDSSolid(Explorer.toSolid(entry.shape)),
        faceColors: entry.faceColors,
      })),
    };
  }

  // Raw methods (for oc-internal use)
  static readBRepRaw(fileName: string, content: string): TopoDS_Shape {
    const oc = getOC();

    oc.FS.writeFile(fileName, content);

    const shape = new oc.TopoDS_Shape();
    const builder = new oc.BRep_Builder();
    const progress = new oc.Message_ProgressRange();

    console.log(`Deserializing shape from virtual file ${fileName}`);
    oc.BRepTools.Read(shape, fileName, builder, progress);
    console.log(`Shape deserialized from virtual file ${fileName} successfully`);

    oc.FS.unlink(fileName);
    progress.delete();

    return shape;
  }

  static writeBRepRaw(shape: TopoDS_Shape, fileName: string): string {
    const oc = getOC();

    console.log(`Serializing shape to file ${fileName} in virtual FS`);
    const writeProgress = new oc.Message_ProgressRange();
    oc.BRepTools.Write(shape, fileName, writeProgress);

    const file = oc.FS.readFile(fileName, { encoding: "utf8" });
    writeProgress.delete();

    console.log(`Serialized shape to file ${fileName}, size: ${file.length} bytes`);
    return file;
  }

  static readStepRaw(fileName: string, data: Uint8Array): TopoDS_Shape {
    const oc = getOC();

    const uint8 = new Uint8Array(data);
    oc.FS.createDataFile("/", fileName, uint8, true, true, true);

    const reader = new oc.STEPControl_Reader();
    const readResult = reader.ReadFile(fileName);

    if (readResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      oc.FS.unlink(fileName);
      reader.delete();
      throw new Error(`Failed to read STEP file. Status: ${readResult}`);
    }

    const progress = new oc.Message_ProgressRange();
    reader.TransferRoots(progress);
    progress.delete();

    const shape = reader.OneShape();
    reader.delete();
    oc.FS.unlink(fileName);

    return shape;
  }

  static readStepXCAF(fileName: string, data: Uint8Array): { docHandle: Handle_TDocStd_Document; cleanup: () => void } {
    const oc = getOC();

    const uint8 = new Uint8Array(data);
    oc.FS.createDataFile("/", fileName, uint8, true, true, true);

    const app = new oc.TDocStd_Application();
    const docHandle = new oc.Handle_TDocStd_Document();
    const format = new oc.TCollection_ExtendedString('MDTV-XCAF');
    app.NewDocument(format, docHandle);
    format.delete();

    const reader = new oc.STEPCAFControl_Reader();
    reader.SetColorMode(true);
    reader.SetNameMode(true);
    reader.SetLayerMode(true);
    reader.SetPropsMode(true);
    reader.SetSHUOMode(true);
    reader.SetMatMode(true);

    const readResult = reader.ReadFile(fileName);

    if (readResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      oc.FS.unlink(fileName);
      reader.delete();
      docHandle.delete();
      app.delete();
      throw new Error(`Failed to read STEP file. Status: ${readResult}`);
    }

    const transferProgress = new oc.Message_ProgressRange();
    const transferred = reader.Transfer(docHandle, transferProgress);
    transferProgress.delete();

    if (!transferred) {
      oc.FS.unlink(fileName);
      reader.delete();
      docHandle.delete();
      app.delete();
      throw new Error('STEP transfer failed');
    }

    const cleanup = () => {
      reader.delete();
      oc.FS.unlink(fileName);
      app.Close(docHandle);
      docHandle.delete();
      app.delete();
    };

    return { docHandle, cleanup };
  }

  static castToSolid(shape: TopoDS_Shape) {
    return Explorer.toSolid(shape);
  }

  static findSolidsRaw(shape: TopoDS_Shape): TopoDS_Shape[] {
    const oc = getOC();
    return Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
  }

  static findFacesRaw(shape: TopoDS_Shape): TopoDS_Shape[] {
    const oc = getOC();
    return Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  }

  static makeCompoundRaw(shapes: TopoDS_Shape[]) {
    const oc = getOC();
    const compound = new oc.TopoDS_Compound();
    const builder = new oc.BRep_Builder();
    builder.MakeCompound(compound);
    for (const shape of shapes) {
      builder.Add(compound, shape);
    }
    return compound;
  }

  static extractSolidsAndColorsRaw(docHandle: Handle_TDocStd_Document): {
    solids: Array<{ shape: TopoDS_Shape; faceColors: Array<{ faceIndex: number; color: string }> }>;
  } {
    const oc = getOC();
    const doc = docHandle.get();
    const shapeToolHandle = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main());
    const colorToolHandle = oc.XCAFDoc_DocumentTool.ColorTool(doc.Main());
    const shapeTool = shapeToolHandle.get();
    const colorTool = colorToolHandle.get();
    const surfType = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;

    const colorLabels = new oc.TDF_LabelSequence();
    colorTool.GetColors(colorLabels);
    console.log(`Total color definitions in document: ${colorLabels.Length()}`);
    colorLabels.delete();

    const faceColorByHash = new Map<number, string>();
    const solidColorByHash = new Map<number, string>();

    const allLabels = new oc.TDF_LabelSequence();
    shapeTool.GetShapes(allLabels);
    let simpleShapeCount = 0;
    let subShapeColorCount = 0;

    for (let i = 1; i <= allLabels.Length(); i++) {
      const label = allLabels.Value(i);
      if (!oc.XCAFDoc_ShapeTool.IsSimpleShape(label)) continue;
      simpleShapeCount++;

      const shape = oc.XCAFDoc_ShapeTool.GetShape(label);

      const labelColor = new oc.Quantity_Color();
      if (colorTool.GetColor(label, surfType, labelColor)) {
        const hex = OcIO.rgbToHex(labelColor.Red(), labelColor.Green(), labelColor.Blue());
        const labelSolids = OcIO.findSolidsRaw(shape);
        for (const s of labelSolids) {
          solidColorByHash.set(s.HashCode(2147483647), hex);
        }
        const labelFaces = OcIO.findFacesRaw(shape);
        for (const f of labelFaces) {
          faceColorByHash.set(f.HashCode(2147483647), hex);
        }
      }
      labelColor.delete();

      const subLabels = new oc.TDF_LabelSequence();
      oc.XCAFDoc_ShapeTool.GetSubShapes(label, subLabels);

      for (let j = 1; j <= subLabels.Length(); j++) {
        const subLabel = subLabels.Value(j);
        const subColor = new oc.Quantity_Color();
        if (colorTool.GetColor(subLabel, surfType, subColor)) {
          const subShape = oc.XCAFDoc_ShapeTool.GetShape(subLabel);
          faceColorByHash.set(subShape.HashCode(2147483647), OcIO.rgbToHex(subColor.Red(), subColor.Green(), subColor.Blue()));
          subShapeColorCount++;
        }
        subColor.delete();
      }
      subLabels.delete();
    }
    allLabels.delete();

    console.log(`Label tree: ${simpleShapeCount} simple shapes, ${subShapeColorCount} sub-shape colors, ${faceColorByHash.size} face entries, ${solidColorByHash.size} solid entries`);

    const freeLabels = new oc.TDF_LabelSequence();
    shapeTool.GetFreeShapes(freeLabels);

    const solids: Array<{ shape: TopoDS_Shape; faceColors: Array<{ faceIndex: number; color: string }> }> = [];

    for (let i = 1; i <= freeLabels.Length(); i++) {
      const label = freeLabels.Value(i);
      const rootShape = oc.XCAFDoc_ShapeTool.GetShape(label);

      const solidShapes = OcIO.findSolidsRaw(rootShape);

      for (const solidShape of solidShapes) {
        const faces = OcIO.findFacesRaw(solidShape);
        const faceColors: Array<{ faceIndex: number; color: string }> = [];

        for (let fi = 0; fi < faces.length; fi++) {
          const face = faces[fi];
          const color = OcIO.findFaceColor(face, solidShape, colorTool, shapeTool, oc, surfType, faceColorByHash, solidColorByHash);

          if (color) {
            faceColors.push({ faceIndex: fi, color });
          }
        }

        solids.push({ shape: solidShape, faceColors });
      }
    }

    freeLabels.delete();
    shapeToolHandle.delete();
    colorToolHandle.delete();

    return { solids };
  }

  private static findFaceColor(
    face: TopoDS_Shape,
    solidShape: TopoDS_Shape,
    colorTool: any,
    shapeTool: any,
    oc: any,
    surfType: any,
    faceColorByHash: Map<number, string>,
    solidColorByHash: Map<number, string>
  ): string | null {
    const hashColor = faceColorByHash.get(face.HashCode(2147483647));
    if (hashColor) return hashColor;

    const color = new oc.Quantity_Color();
    if (colorTool.GetColor(face, surfType, color)) {
      const hex = OcIO.rgbToHex(color.Red(), color.Green(), color.Blue());
      color.delete();
      return hex;
    }

    if (colorTool.GetInstanceColor(face, surfType, color)) {
      const hex = OcIO.rgbToHex(color.Red(), color.Green(), color.Blue());
      color.delete();
      return hex;
    }

    const identityLoc = new oc.TopLoc_Location();
    const unlocatedFace = face.Located(identityLoc, false);
    if (colorTool.GetColor(unlocatedFace, surfType, color)) {
      const hex = OcIO.rgbToHex(color.Red(), color.Green(), color.Blue());
      color.delete();
      identityLoc.delete();
      return hex;
    }
    identityLoc.delete();

    const faceLabel = new oc.TDF_Label();
    if (shapeTool.SearchUsingMap(face, faceLabel, true, true)) {
      if (colorTool.GetColor(faceLabel, surfType, color)) {
        const hex = OcIO.rgbToHex(color.Red(), color.Green(), color.Blue());
        color.delete();
        return hex;
      }
    }
    color.delete();

    const solidHash = solidColorByHash.get(solidShape.HashCode(2147483647));
    if (solidHash) return solidHash;

    const solidColor = new oc.Quantity_Color();
    if (colorTool.GetColor(solidShape, surfType, solidColor) ||
        colorTool.GetInstanceColor(solidShape, surfType, solidColor)) {
      const hex = OcIO.rgbToHex(solidColor.Red(), solidColor.Green(), solidColor.Blue());
      solidColor.delete();
      return hex;
    }
    solidColor.delete();

    return null;
  }

  private static rgbToHex(r: number, g: number, b: number): string {
    const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
}
