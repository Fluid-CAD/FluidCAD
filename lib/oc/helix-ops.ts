import type { TopoDS_Edge } from "fluidcad-ocjs";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Edge } from "../common/edge.js";
import { CoordinateSystem } from "../math/coordinate-system.js";

/**
 * Builds 3D helix edges with OCCT's TKHelix package (`HelixGeom_Tools.ApprHelix`),
 * which approximates the analytic helix as a single B-spline curve. Cylindrical
 * and tapered (conical) helixes come from one uniform call — the taper is driven
 * purely by the difference between the start and end radii over the axial range.
 */
export class HelixOps {
  // B-spline approximation tolerance for the analytic helix, in mm.
  private static readonly APPROX_TOLERANCE = 1e-4;

  /**
   * Build a helix edge running `turns` full revolutions, climbing along
   * `cs.mainDirection` from axial coordinate `zStart` to `zEnd` and starting at
   * angle 0 (the `cs.xDirection` ray). `startRadius` is the radius at `zStart`;
   * when `endRadius` differs the radius tapers linearly to it at `zEnd`, yielding
   * a conical helix (`endRadius === startRadius` gives a constant-radius cylinder).
   */
  static makeHelix(
    cs: CoordinateSystem,
    startRadius: number,
    endRadius: number,
    zStart: number,
    zEnd: number,
    turns: number,
  ): Edge {
    const oc = getOC();

    const height = zEnd - zStart;
    const pitch = height / turns;
    const taperAngle = Math.atan2(endRadius - startRadius, height);
    const lastAngle = 2 * Math.PI * turns;

    // ApprHelix builds the helix in the canonical frame (axis +Z through the
    // origin, angle 0 on +X) and returns one B-spline spanning every turn.
    const appr = oc.HelixGeom_Tools.ApprHelix(
      0, lastAngle, pitch, startRadius, taperAngle, false, HelixOps.APPROX_TOLERANCE,
    );
    if (appr.returnValue !== 0) {
      appr[Symbol.dispose]();
      throw new Error(`HelixOps: ApprHelix failed (status ${appr.returnValue}).`);
    }

    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(appr.theBSpl);
    const canonicalEdge = edgeMaker.Edge();

    // Relocate the canonical helix into the target frame (copies the geometry, so
    // the result is independent of the approximation envelope released below).
    const placedEdge = HelixOps.placeInFrame(canonicalEdge, cs, zStart);

    edgeMaker.delete();
    canonicalEdge.delete();
    appr[Symbol.dispose]();

    return Edge.fromTopoDSEdge(placedEdge);
  }

  /**
   * Rigidly move an edge built in the canonical frame (axis +Z through the
   * origin) so it sits in `cs`, lifted along `cs.mainDirection` by `zStart`.
   */
  private static placeInFrame(
    edge: TopoDS_Edge,
    cs: CoordinateSystem,
    zStart: number,
  ): TopoDS_Edge {
    const oc = getOC();

    const origin = cs.origin.add(cs.mainDirection.normalize().multiply(zStart));
    const placedCs = new CoordinateSystem(origin, cs.mainDirection, cs.xDirection);
    const [ax3, disposeAx3] = Convert.toGpAx3(placedCs);

    const trsf = new oc.gp_Trsf();
    trsf.SetTransformation(ax3); // global coords → target frame …
    trsf.Invert();               // … inverted places canonical geometry at the target frame
    const transform = new oc.BRepBuilderAPI_Transform(edge, trsf, true);
    const placedEdge = oc.TopoDS.Edge(transform.Shape());

    transform.delete();
    trsf.delete();
    disposeAx3();

    return placedEdge;
  }
}
