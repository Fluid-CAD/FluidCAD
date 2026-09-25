import type { TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import type { SpineAnalysis, SpineTrihedron } from "./sweep/spine-analysis.js";
import { PipeRun, type PipeRunResult } from "./sweep/pipe-run.js";
import { CorneredSweep } from "./sweep/cornered-sweep.js";
import { resolveSweepSpec, type ResolvedSweepSpec, type SweepPlacement, type SweepTolerancePolicy } from "./sweep/sweep-spec.js";

export interface SweepResult {
  solids: Solid[];
  firstShape: TopoDS_Shape;
  lastShape: TopoDS_Shape;
}

export class SweepOps {
  static makeSweep(spineWire: Wire, profileFaces: Face[]): SweepResult {
    return SweepOps.buildResolved(resolveSweepSpec(spineWire, profileFaces));
  }

  static buildResolved(spec: ResolvedSweepSpec): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    let firstShape: TopoDS_Shape | null = null;
    let lastShape: TopoDS_Shape | null = null;

    const { spine, profileFaces, transport, placement, tolerances } = spec;

    for (const face of profileFaces) {
      const ocFace = oc.TopoDS.Face(face.getShape());
      const outerWire = oc.BRepTools.OuterWire(ocFace);
      const innerWires = face.getWires()
        .map(w => w.getShape())
        .filter(w => !w.IsSame(outerWire));

      const outer = SweepOps.sweepWire(spine, outerWire, transport, placement, tolerances);

      let resultSolid = outer.solid;
      let resultFirst = outer.firstFace;
      let resultLast = outer.lastFace;

      for (const innerWire of innerWires) {
        const inner = SweepOps.sweepWire(spine, oc.TopoDS.Wire(innerWire), transport, placement, tolerances);

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
    placement: SweepPlacement,
    tolerances: SweepTolerancePolicy,
  ): PipeRunResult {
    const withCorrection = placement.kind === "legacyAutomatic" && placement.withCorrection;
    if (!spine.hasCorners) {
      return PipeRun.sweep(spine.wire, {
        wire: profile, placed: placement.kind === "atVertex", withCorrection,
        location: placement.kind === "atVertex" ? placement.vertex : undefined,
      }, trihedron, tolerances);
    }
    if (placement.kind === "atVertex") {
      throw new Error("Explicit sweep stations are currently supported only on smooth paths.");
    }
    return CorneredSweep.build(spine, profile, trihedron, withCorrection, tolerances);
  }
}
