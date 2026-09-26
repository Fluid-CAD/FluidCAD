import type { TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import type { SpineAnalysis, SpineTrihedron } from "./sweep/spine-analysis.js";
import { PipeRun, type PipeRunResult, type PipeRunDiagnostics } from "./sweep/pipe-run.js";
import { CorneredSweep } from "./sweep/cornered-sweep.js";
import { resolveSweepSpec, type ResolvedSweepSpec, type SweepPlacement, type SweepTolerancePolicy } from "./sweep/sweep-spec.js";
import type { Plane } from "../math/plane.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { Point } from "../math/point.js";
import { BooleanOps } from "./boolean-ops.js";
import type { ResolvedHelixGeometry } from "../math/helix-geometry.js";

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
  /** Fit evidence for each outer/inner run, before hole cuts or corner joins. */
  diagnostics: PipeRunDiagnostics[];
}

export class SweepOps {
  static makeSweep(spineWire: Wire, profileFaces: Face[], profilePlane?: Plane): SweepResult {
    return SweepOps.buildResolved(resolveSweepSpec(spineWire, profileFaces, { profilePlane }));
  }

  static buildResolved(spec: ResolvedSweepSpec): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    const faceRoles: SweepFaceRole[] = [];
    const diagnostics: PipeRunDiagnostics[] = [];
    let firstShape: TopoDS_Shape | null = null;
    let lastShape: TopoDS_Shape | null = null;

    const { spine, profileFaces, transport, placement, tolerances, helixGeometry } = spec;

    // Every temporary native handle is owned here, including abandoned
    // regions when a later hole or validation fails. Returned solids/caps
    // receive independent handles before this scope releases its copies.
    const owned = new Set<TopoDS_Shape>();
    const own = <T extends TopoDS_Shape>(shape: T): T => { owned.add(shape); return shape; };
    const ownPipe = (pipe: PipeRunResult) => {
      own(pipe.solid); own(pipe.firstFace); own(pipe.lastFace);
      pipe.generatedFaces?.forEach(entry => entry.faces.forEach(own));
      diagnostics.push(...pipe.diagnostics);
      return pipe;
    };
    try {
      for (const face of profileFaces) {
        const ocFace = own(oc.TopoDS.Face(face.getShape()));
        const outerWire = own(oc.BRepTools.OuterWire(ocFace));
        const innerWires = face.getWires().map(w => w.getShape()).filter(w => !w.IsSame(outerWire));
        const outer = ownPipe(SweepOps.sweepWire(spine, outerWire, transport, placement, tolerances, helixGeometry));
        let origins = (outer.generatedFaces ?? []).map(entry => ({ ...entry, internal: false }));
        let resultSolid = outer.solid;
        let resultFirst = outer.firstFace;
        let resultLast = outer.lastFace;

        for (const innerWire of innerWires) {
          const inner = ownPipe(SweepOps.sweepWire(spine, own(oc.TopoDS.Wire(innerWire)), transport, placement, tolerances, helixGeometry));
          origins.push(...(inner.generatedFaces ?? []).map(entry => ({ ...entry, internal: true })));
          const hole = BooleanOps.cutWithHistory([resultSolid], [inner.solid], { validate: true, stage: "Sweep hole cut" });
          const newSolid = own(hole.result);
          try {
            if (hole.empty) throw new Error("Sweep hole cut removed the entire profile.");
            resultFirst = own(ShapeOps.trackFace(hole.maker, resultFirst, newSolid));
            resultLast = own(ShapeOps.trackFace(hole.maker, resultLast, newSolid));
            // Carry every lateral span through the hole cut, including reversed
            // tool walls. Start-cap adjacency loses the later bounded spans.
            origins = origins.map(entry => ({ ...entry, faces: entry.faces.flatMap(face => {
              const modified = ShapeOps.shapeListToArray(hole.maker.Modified(face)).map(own);
              if (modified.length > 0) return modified;
              return hole.maker.IsDeleted(face) ? [] : [face];
            }) }));
            resultSolid = newSolid;
          } finally { hole.dispose(); }
        }

        if (!firstShape) { firstShape = resultFirst; lastShape = resultLast; }
        const solids = Explorer.findShapes(resultSolid, Explorer.getOcShapeType("solid")).map(own);
        for (const solid of solids) {
          const faces = Explorer.findShapes(solid, Explorer.getOcShapeType("face")).map(own);
          faces.forEach((face, faceIndex) => {
            const origin = origins.find(entry => entry.faces.some(generated => generated.IsSame(face)));
            faceRoles.push({
              solidIndex: allSolids.length, faceIndex,
              kind: face.IsSame(resultFirst) ? "start" : face.IsSame(resultLast) ? "end"
                : origin?.internal ? "inner" : "side",
              profileMidpoint: origin?.profileMidpoint,
            });
          });
          allSolids.push(Solid.fromTopoDSSolid(Explorer.toSolid(solid)));
        }
      }

      if (allSolids.length === 0) throw new Error("Sweep produced no solids.");
      return {
        solids: allSolids,
        firstShape: firstShape!.Oriented(firstShape!.Orientation()),
        lastShape: lastShape!.Oriented(lastShape!.Orientation()),
        profileTransform: placement.kind === "atStart" ? placement.transform : undefined,
        faceRoles, diagnostics,
      };
    } catch (error) {
      allSolids.forEach(solid => solid.dispose());
      throw error;
    } finally { owned.forEach(shape => shape.delete()); }
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
    helixGeometry?: ResolvedHelixGeometry,
  ): PipeRunResult {
    const withCorrection = placement.kind === "legacyAutomatic" && placement.withCorrection;
    if (!spine.hasCorners) {
      return PipeRun.sweep(spine.wire, {
        wire: profile, placed: placement.kind !== "legacyAutomatic", withCorrection,
        location: placement.kind === "atVertex" ? placement.vertex : undefined,
        atStart: placement.kind === "atStart",
        transform: placement.kind === "atStart" ? placement.transform : undefined,
      }, trihedron, tolerances, helixGeometry);
    }
    if (placement.kind !== "legacyAutomatic") {
      throw new Error("Explicit sweep stations are currently supported only on smooth paths.");
    }
    return CorneredSweep.build(spine, profile, trihedron, withCorrection, tolerances);
  }
}
