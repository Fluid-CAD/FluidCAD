import type { TopoDS_Edge } from "fluidcad-ocjs";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Edge } from "../common/edge.js";
import { CoordinateSystem } from "../math/coordinate-system.js";

/**
 * Builds 3D helix edges with OCCT's TKHelix package. The analytic helix
 * (`HelixGeom_HelixCurve`) is approximated as a single B-spline via
 * `HelixGeom_Tools.ApprCurve3D`. Cylindrical and tapered (conical) helixes come
 * from one uniform call — the taper is driven purely by the difference between
 * the start and end radii over the axial range.
 *
 * NB: we deliberately do NOT use `HelixGeom_Tools.ApprHelix`, which hardcodes a
 * 150-segment approximation budget. That is plenty for a cylinder (~3 segments
 * per turn) but far too few for a many-turn tapered helix (~25+ per turn): the
 * single-B-spline fit silently saturates the budget and oscillates wildly over
 * the final turns while still reporting success (returnValue 0, theMaxError in
 * the tens of mm). ApprCurve3D lets us scale the segment budget with the turn
 * count so the adaptive fit can actually reach tolerance.
 */
export class HelixOps {
  // B-spline approximation tolerance for the analytic helix, in mm.
  private static readonly APPROX_TOLERANCE = 1e-4;
  // Max B-spline degree for the fit (matches OCCT's ApprHelix default).
  private static readonly MAX_DEGREE = 8;
  // Segment budget per turn. A tapered helix needs ~25 segments/turn to reach
  // APPROX_TOLERANCE; 40 leaves headroom. This is only a ceiling — the adaptive
  // fit stops as soon as tolerance is met (a cylinder converges far below it).
  private static readonly SEGMENTS_PER_TURN = 40;
  // Floor (OCCT's ApprHelix default, ample for few-turn helixes) and ceiling on
  // the per-build segment budget.
  private static readonly MIN_SEGMENTS = 150;
  private static readonly MAX_SEGMENTS = 4000;

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
    const maxSegments = Math.min(
      HelixOps.MAX_SEGMENTS,
      Math.max(HelixOps.MIN_SEGMENTS, Math.ceil(turns) * HelixOps.SEGMENTS_PER_TURN),
    );

    // Build the analytic helix in the canonical frame (axis +Z through the
    // origin, angle 0 on +X) and approximate it as one B-spline spanning every
    // turn. ApprCurve3D (not ApprHelix) so the segment budget scales with turns.
    const adaptor = new oc.HelixGeom_HelixCurve();
    adaptor.Load(0, lastAngle, pitch, startRadius, taperAngle, false);

    const appr = oc.HelixGeom_Tools.ApprCurve3D(
      adaptor,
      HelixOps.APPROX_TOLERANCE,
      oc.GeomAbs_Shape.GeomAbs_C2,
      maxSegments,
      HelixOps.MAX_DEGREE,
    );
    if (appr.returnValue !== 0) {
      appr[Symbol.dispose]();
      adaptor.delete();
      throw new Error(`HelixOps: helix approximation failed (status ${appr.returnValue}).`);
    }

    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(appr.theBSpl);
    const canonicalEdge = edgeMaker.Edge();

    // Relocate the canonical helix into the target frame (copies the geometry, so
    // the result is independent of the approximation envelope released below).
    const placedEdge = HelixOps.placeInFrame(canonicalEdge, cs, zStart);

    edgeMaker.delete();
    canonicalEdge.delete();
    appr[Symbol.dispose]();
    adaptor.delete();

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
