import type { TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { SpineAnalysis, type SpineTrihedron } from "./sweep/spine-analysis.js";
import { PipeRun, type PipeRunResult } from "./sweep/pipe-run.js";
import { CorneredSweep } from "./sweep/cornered-sweep.js";

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

    const profilePlane = profileFaces[0].getPlane();
    const spine = new SpineAnalysis(spineWire);
    const trihedron = spine.trihedron(profilePlane);

    // `Add(_, false, true)` (no contact, with correction) rotates the profile
    // to sit perpendicular to the spine tangent, about an axis given by
    // `profile.normal × spine.tangent`. That axis is undefined when the two are
    // anti-parallel — but then the profile plane is *already* perpendicular to
    // the spine (its normal is ∥ -tangent), so no correction is needed: skip it
    // and keep the profile's drawn position.
    const isAntiParallel = profilePlane.normal.dot(spine.startTangent) < -0.999;
    const withCorrection = !isAntiParallel;

    for (const face of profileFaces) {
      const ocFace = oc.TopoDS.Face(face.getShape());
      const outerWire = oc.BRepTools.OuterWire(ocFace);
      const innerWires = face.getWires()
        .map(w => w.getShape())
        .filter(w => !w.IsSame(outerWire));

      const outer = SweepOps.sweepWire(spine, outerWire, trihedron, withCorrection);

      let resultSolid = outer.solid;
      let resultFirst = outer.firstFace;
      let resultLast = outer.lastFace;

      for (const innerWire of innerWires) {
        const inner = SweepOps.sweepWire(spine, oc.TopoDS.Wire(innerWire), trihedron, withCorrection);

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
        resultFirst = ShapeOps.trackFace(cut, resultFirst, newSolid);
        resultLast = ShapeOps.trackFace(cut, resultLast, newSolid);

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

    if (allSolids.length === 0) {
      throw new Error("Sweep produced no solids.");
    }

    return {
      solids: allSolids,
      firstShape: firstShape!,
      lastShape: lastShape!,
    };
  }

  /**
   * Sweeps a single wire along the spine. A G1 spine is one pipe; a spine
   * with sharp corners is swept run by run and joined at the corners.
   */
  private static sweepWire(
    spine: SpineAnalysis,
    profile: TopoDS_Wire,
    trihedron: SpineTrihedron,
    withCorrection: boolean,
  ): PipeRunResult {
    if (!spine.hasCorners) {
      return PipeRun.sweep(spine.wire, { wire: profile, placed: false, withCorrection }, trihedron);
    }
    return CorneredSweep.build(spine, profile, trihedron, withCorrection);
  }
}
