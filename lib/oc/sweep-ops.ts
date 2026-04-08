import type { TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";

export interface SweepResult {
  solids: Solid[];
  firstShape: TopoDS_Shape;
  lastShape: TopoDS_Shape;
}

export class SweepOps {
  static makeSweep(spineWire: Wire, profileFaces: Face[]): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    let firstShape: TopoDS_Shape | null = null;
    let lastShape: TopoDS_Shape | null = null;

    for (const face of profileFaces) {
      const pipe = new oc.BRepOffsetAPI_MakePipe(spineWire.getShape(), face.getShape());

      const progress = new oc.Message_ProgressRange();
      pipe.Build(progress);
      progress.delete();

      if (!pipe.IsDone()) {
        pipe.delete();
        throw new Error("Sweep operation failed.");
      }

      if (!firstShape) {
        firstShape = pipe.FirstShape();
        lastShape = pipe.LastShape();
      }

      const result = pipe.Shape();
      pipe.delete();

      const solids = Explorer.findShapes(result, Explorer.getOcShapeType("solid"));
      for (const s of solids) {
        allSolids.push(Solid.fromTopoDSSolid(Explorer.toSolid(s)));
      }
    }

    if (allSolids.length === 0) {
      throw new Error("Sweep produced no solids.");
    }

    return {
      solids: allSolids,
      firstShape: firstShape!,
      lastShape: lastShape!,
    };
  }
}
