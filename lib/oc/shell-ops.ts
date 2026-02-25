import type { TopoDS_Face, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { ShapeOps } from "./shape-ops.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { ShapeFactory } from "../common/shape-factory.js";

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

    const newShape = maker.Shape();
    maker.delete();
    listOfFaces.delete();
    return ShapeFactory.fromShape(ShapeOps.cleanShapeRaw(newShape));
  }
}
