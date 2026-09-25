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
import type { Plane } from "../math/plane.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { Point } from "../math/point.js";

export interface SweepFaceRole {
  solidIndex: number;
  faceIndex: number;
  kind: "start" | "end" | "side" | "inner";
  profileMidpoint?: Point;
}

export interface SweepResult {
  solids: Solid[];
  firstShape: TopoDS_Shape;
  lastShape: TopoDS_Shape;
  /** Mapping from drawn profile geometry to the start cap, for thin-wall classification. */
  profileTransform?: Matrix4;
  /** Numeric references into the returned solids; no additional native handles. */
  faceRoles: SweepFaceRole[];
}

export class SweepOps {
  static makeSweep(spineWire: Wire, profileFaces: Face[], profilePlane?: Plane): SweepResult {
    return SweepOps.buildResolved(resolveSweepSpec(spineWire, profileFaces, { profilePlane }));
  }

  static buildResolved(spec: ResolvedSweepSpec): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    const faceRoles: SweepFaceRole[] = [];
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
      let origins = (outer.generatedFaces ?? []).map(entry => ({ ...entry, internal: false }));

      let resultSolid = outer.solid;
      let resultFirst = outer.firstFace;
      let resultLast = outer.lastFace;

      for (const innerWire of innerWires) {
        const inner = SweepOps.sweepWire(spine, oc.TopoDS.Wire(innerWire), transport, placement, tolerances);
        origins.push(...(inner.generatedFaces ?? []).map(entry => ({ ...entry, internal: true })));

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

        // Carry every lateral span through the hole cut, including the
        // reversed images of the inner tool walls. Start-cap adjacency only
        // identifies the first span and loses the rest of a segmented wall.
        origins = origins.map(entry => ({ ...entry, faces: entry.faces.flatMap(face => {
          const modified = ShapeOps.shapeListToArray(cut.Modified(face));
          if (modified.length > 0) { face.delete(); return modified; }
          if (cut.IsDeleted(face)) { face.delete(); return []; }
          return [face];
        }) }));

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
        const faces = Explorer.findShapes(s, Explorer.getOcShapeType("face"));
        faces.forEach((face, faceIndex) => {
          const origin = origins.find(entry => entry.faces.some(generated => generated.IsSame(face)));
          faceRoles.push({
            solidIndex: allSolids.length, faceIndex,
            kind: face.IsSame(resultFirst) ? "start" : face.IsSame(resultLast) ? "end"
              : origin?.internal ? "inner" : "side",
            profileMidpoint: origin?.profileMidpoint,
          });
          face.delete();
        });
        allSolids.push(Solid.fromTopoDSSolid(Explorer.toSolid(s)));
      }
      origins.forEach(entry => entry.faces.forEach(face => face.delete()));
    }

    if (allSolids.length === 0) {
      throw new Error("Sweep produced no solids.");
    }

    return {
      solids: allSolids,
      firstShape: firstShape!,
      lastShape: lastShape!,
      profileTransform: placement.kind === "atStart" ? placement.transform : undefined,
      faceRoles,
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
        wire: profile, placed: placement.kind !== "legacyAutomatic", withCorrection,
        location: placement.kind === "atVertex" ? placement.vertex : undefined,
        atStart: placement.kind === "atStart",
        transform: placement.kind === "atStart" ? placement.transform : undefined,
      }, trihedron, tolerances);
    }
    if (placement.kind !== "legacyAutomatic") {
      throw new Error("Explicit sweep stations are currently supported only on smooth paths.");
    }
    return CorneredSweep.build(spine, profile, trihedron, withCorrection, tolerances);
  }
}
