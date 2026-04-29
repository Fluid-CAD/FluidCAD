import { getOC } from "./init.js";
import { ShapeOps } from "./shape-ops.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { ColorTransfer } from "./color-transfer.js";

export class ShellOps {
  static makeThickSolid(solid: Shape, faces: Face[], thickness: number): Shape {
    const oc = getOC();
    const listOfFaces = new oc.TopTools_ListOfShape();

    for (const f of faces) {
      listOfFaces.Append(f.getShape());
    }

    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    const progress = new oc.Message_ProgressRange();
    maker.MakeThickSolidByJoin(oc.TopoDS.Solid(solid.getShape()), listOfFaces, thickness, oc.Precision.Confusion(), oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, progress);

    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      listOfFaces.delete();
      throw new Error("Failed to create thick solid.");
    }

    // Wrap the maker output so we can transfer colors before disposing it.
    // The user-painted outer faces are mapped through `Modified()`; new
    // internal walls have no source and stay uncolored — bleeding is
    // intentionally skipped so painting the outside doesn't paint the
    // inside.
    const preClean = ShapeFactory.fromShape(maker.Shape());
    ColorTransfer.applyThroughMaker([solid], [preClean], maker);
    maker.delete();
    listOfFaces.delete();

    // Chain colors through the UnifySameDomain cleanup so any merged faces
    // keep the colors that `applyThroughMaker` just placed.
    const cleanup = ShapeOps.cleanShapeWithLineage(preClean);
    ColorTransfer.applyThroughCleanup(preClean, cleanup);
    const cleaned = cleanup.shape;
    cleanup.dispose();
    return cleaned;
  }
}
