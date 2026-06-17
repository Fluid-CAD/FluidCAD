import type { TopoDS_Shape, TopoDS_Wire, gp_Dir } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Vector3d } from "../math/vector3d.js";

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
  // Ceiling for MakePipeShell's swept-surface approximation. OCCT's default
  // (~30) is too small for tapered or tightly-coiled helical spines, whose
  // swept surfaces need many spans to fit within tolerance — at the default the
  // build silently fails (BRepBuilderAPI_PipeNotDone). This only caps the
  // adaptive fit; simple spines converge far below it at no extra cost.
  private static readonly MAX_PIPE_SEGMENTS = 1000;

  static makeSweep(spineWire: Wire, profileFaces: Face[]): SweepResult {
    const oc = getOC();

    const allSolids: Solid[] = [];
    let firstShape: TopoDS_Shape | null = null;
    let lastShape: TopoDS_Shape | null = null;

    const profilePlane = profileFaces[0].getPlane();

    // Fixed binormal for MakePipeShell's `SetMode`: it locks the section's
    // "up", so the profile keeps a constant angle to it instead of twisting
    // along the spine. The correct direction is the axis the spine's tangent
    // rotates around — the plane normal for a planar spine, the coil axis for a
    // helix. The tangent keeps a constant, non-zero angle to that axis, so the
    // section never flips and the result is a clean coil.
    //
    // The profile plane's own "up" (used previously) only works when it happens
    // to equal that axis — true for a profile sketched on a world plane, but
    // NOT for a plane built off a helix, whose in-plane axes are arbitrary.
    // A wrong (e.g. roughly horizontal) binormal lets the helix tangent rotate
    // into it, collapsing `Normal = BiNormal × Tangent` ~twice per turn and
    // shredding the section into a self-intersecting ribbon. A straight spine
    // has no rotation axis (the cross products vanish); there the profile's up
    // is well-defined and never aligns with the constant tangent, so use it.
    const spineAxis = SweepOps.tangentRotationAxis(spineWire.getShape() as TopoDS_Wire);
    const binormalVec = spineAxis ?? profilePlane.yDirection;
    const [binormalDir, disposeBinormal] = Convert.toGpDir(binormalVec);

    // `Add(_, false, true)` (no contact, with correction) rotates the profile
    // to sit perpendicular to the spine tangent, about an axis given by
    // `profile.normal × spine.tangent`. That axis is undefined when the two are
    // anti-parallel — but then the profile plane is *already* perpendicular to
    // the spine (its normal is ∥ -tangent), so no correction is needed: skip it
    // and keep the profile's drawn position.
    const spineTangent = SweepOps.getSpineTangent(spineWire.getShape() as TopoDS_Wire);
    const isAntiParallel = profilePlane.normal.dot(spineTangent) < -0.999;
    const withCorrection = !isAntiParallel;

    try {
      for (const face of profileFaces) {
        const ocFace = oc.TopoDS.Face(face.getShape());
        const outerWire = oc.BRepTools.OuterWire(ocFace);
        const innerWires = face.getWires()
          .map(w => w.getShape())
          .filter(w => !w.IsSame(outerWire));

        const outer = SweepOps.sweepWire(spineWire.getShape(), outerWire, binormalDir, withCorrection);

        let resultSolid = outer.solid;
        let resultFirst = outer.firstFace;
        let resultLast = outer.lastFace;

        for (const innerWire of innerWires) {
          const inner = SweepOps.sweepWire(spineWire.getShape(), oc.TopoDS.Wire(innerWire), binormalDir, withCorrection);

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
  private static sweepWire(
    spine: TopoDS_Wire,
    profile: TopoDS_Wire,
    binormalDir: gp_Dir,
    withCorrection: boolean,
  ): WireSweep {
    const oc = getOC();
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    // Fixed binormal (the spine's tangent-rotation axis; see makeSweep): keeps
    // the swept section from twisting — a clean coil rather than a wobbling
    // ribbon — and is well-defined on straight spines, where Frenet is not
    // (zero curvature ⇒ undefined normal).
    pipe.SetMode(binormalDir);
    // Give the swept-surface approximation enough spans for tapered/tight
    // helical spines (see MAX_PIPE_SEGMENTS) — at OCCT's default budget the
    // build fails on, e.g., a conical helix or a many-turn helix on a cone face.
    pipe.SetMaxSegments(SweepOps.MAX_PIPE_SEGMENTS);
    pipe.Add(profile, false, withCorrection);

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

  /**
   * The axis the spine's tangent rotates around, = normalize(Σ Tᵢ × Tᵢ₊₁) over
   * tangents sampled along the spine. For a planar spine this is the plane
   * normal; for a helix it is the coil axis. For a straight spine the tangent
   * is constant, every cross product vanishes, and it returns null.
   */
  private static tangentRotationAxis(spine: TopoDS_Wire): Vector3d | null {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_CompCurve(spine, false);
    const u0 = adaptor.FirstParameter();
    const u1 = adaptor.LastParameter();
    const SAMPLES = 64;

    const tangents: Vector3d[] = [];
    const pnt = new oc.gp_Pnt();
    const vec = new oc.gp_Vec();
    for (let i = 0; i <= SAMPLES; i++) {
      const u = u0 + ((u1 - u0) * i) / SAMPLES;
      adaptor.D1(u, pnt, vec);
      const t = new Vector3d(vec.X(), vec.Y(), vec.Z());
      if (t.length() > 1e-9) {
        tangents.push(t.normalize());
      }
    }
    pnt.delete();
    vec.delete();
    adaptor.delete();

    let axis = new Vector3d(0, 0, 0);
    for (let i = 0; i + 1 < tangents.length; i++) {
      axis = axis.add(tangents[i].cross(tangents[i + 1]));
    }
    if (axis.length() < 1e-6) {
      return null;
    }
    return axis.normalize();
  }

  /** Unit tangent of the spine wire at its first parameter. */
  private static getSpineTangent(spine: TopoDS_Wire): Vector3d {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_CompCurve(spine, false);
    const u0 = adaptor.FirstParameter();
    const pnt = new oc.gp_Pnt();
    const tan = new oc.gp_Vec();
    adaptor.D1(u0, pnt, tan);
    tan.Normalize();
    const tangent = new Vector3d(tan.X(), tan.Y(), tan.Z());
    pnt.delete();
    tan.delete();
    adaptor.delete();
    return tangent;
  }
}
