import type { TopoDS_Shape, TopoDS_Wire, gp_Dir } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";

export interface SweepResult {
  solids: Solid[];
  firstShape: TopoDS_Shape;
  lastShape: TopoDS_Shape;
}

interface WireSweep {
  solid: TopoDS_Shape;
  firstFace: TopoDS_Shape;
  lastFace: TopoDS_Shape;
}

export class SweepOps {
  static makeSweep(spineWire: Wire, profileFaces: Face[]): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    let firstShape: TopoDS_Shape | null = null;
    let lastShape: TopoDS_Shape | null = null;

    // Fixed binormal stops the profile from twisting around helical or
    // otherwise-curved spines. The profile plane's in-plane Y axis is
    // perpendicular to the spine tangent at the profile location and, for
    // sketches set up parallel to a world axis, lines up with that axis
    // (e.g. profile in XZ → binormal = ±Z = helix axis).
    const binormalVec = profileFaces[0].getPlane().yDirection;
    const [binormalDir, disposeBinormal] = Convert.toGpDir(binormalVec);

    try {
      for (const face of profileFaces) {
        const rawFace = oc.TopoDS.Face(face.getShape());
        const outerWire = oc.BRepTools.OuterWire(rawFace);
        const innerWires = face.getWires()
          .map(w => w.getShape())
          .filter(w => !w.IsSame(outerWire));

        const outer = SweepOps.sweepWire(spineWire.getShape(), outerWire, binormalDir);

        let resultSolid = outer.solid;
        let resultFirst = outer.firstFace;
        let resultLast = outer.lastFace;

        for (const innerWire of innerWires) {
          const inner = SweepOps.sweepWire(spineWire.getShape(), innerWire, binormalDir);

          const stockList = new oc.TopTools_ListOfShape();
          stockList.Append(resultSolid);
          const toolList = new oc.TopTools_ListOfShape();
          toolList.Append(inner.solid);

          const cut = new oc.BRepAlgoAPI_Cut();
          cut.SetArguments(stockList);
          cut.SetTools(toolList);

          const progress = new oc.Message_ProgressRange();
          cut.Build(progress);
          progress.delete();

          if (!cut.IsDone()) {
            cut.delete();
            stockList.delete();
            toolList.delete();
            throw new Error("Sweep hole cut failed.");
          }

          const newSolid = cut.Shape();

          // Track first/last faces through the cut. The outer's start/end
          // face becomes a hole-bearing face after cutting through it.
          const modFirst = ShapeOps.shapeListToArray(cut.Modified(resultFirst));
          const modLast = ShapeOps.shapeListToArray(cut.Modified(resultLast));
          if (modFirst.length > 0) {
            resultFirst = modFirst[0];
          }
          if (modLast.length > 0) {
            resultLast = modLast[0];
          }

          cut.delete();
          stockList.delete();
          toolList.delete();

          resultSolid = newSolid;
        }

        if (!firstShape) {
          firstShape = resultFirst;
          lastShape = resultLast;
        }

        const solids = Explorer.findShapes(resultSolid, Explorer.getOcShapeType("solid"));
        for (const s of solids) {
          allSolids.push(Solid.fromTopoDSSolid(Explorer.toSolid(s)));
        }
      }
    } finally {
      disposeBinormal();
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

  /** Sweep a single wire along the spine with a fixed binormal. */
  private static sweepWire(spine: TopoDS_Wire, profile: TopoDS_Wire, binormalDir: gp_Dir): WireSweep {
    const oc = getOC();
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    pipe.SetMode(binormalDir);
    pipe.Add(profile, true, true);

    const progress = new oc.Message_ProgressRange();
    pipe.Build(progress);
    progress.delete();

    if (!pipe.IsDone()) {
      pipe.delete();
      throw new Error("Sweep operation failed.");
    }

    if (!pipe.MakeSolid()) {
      pipe.delete();
      throw new Error("Sweep failed to produce a solid.");
    }

    const firstFace = pipe.FirstShape();
    const lastFace = pipe.LastShape();
    const solid = pipe.Shape();
    pipe.delete();

    return { solid, firstFace, lastFace };
  }
}
