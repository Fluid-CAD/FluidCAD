import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Edge } from "../common/edge.js";
import { CoordinateSystem } from "../math/coordinate-system.js";

/**
 * Builds 3D helix edges by laying a 2D line in the parametric (UV) space of a
 * cylindrical or conical surface. A straight line in UV maps to a helix in 3D
 * because U is the angular position and V is the axial (cylinder) or slant
 * (cone) coordinate.
 *
 * Both helpers take **axial Z** parameters (`zStart`, `zEnd`) — for cones, the
 * conversion to slant-V (`/ cos(semiAngle)`) happens inside.
 */
export class HelixOps {
  /**
   * Build a constant-radius helix on a cylindrical surface defined by `cs`
   * (axis frame) and `radius`. The helix runs from axial coordinate `zStart`
   * to `zEnd` and completes `turns` full revolutions.
   */
  static makeCylindricalHelix(
    cs: CoordinateSystem,
    radius: number,
    zStart: number,
    zEnd: number,
    turns: number,
  ): Edge {
    const oc = getOC();
    const [ax3, disposeAx3] = Convert.toGpAx3(cs);

    const cylSurf = new oc.Geom_CylindricalSurface(ax3, radius);
    const surfHandle = new oc.Handle_Geom_Surface(cylSurf);

    const angle = 2 * Math.PI * turns;
    const edge = HelixOps.buildHelixEdgeFromUV(
      surfHandle, 0, zStart, angle, zEnd,
    );

    surfHandle.delete();
    cylSurf.delete();
    disposeAx3();

    return edge;
  }

  /**
   * Build a variable-radius helix on a conical surface. `semiAngle` is the
   * half-angle between the cone axis and its slant (signed: positive widens
   * with V, negative narrows). `refRadius` is the radius at V=0 in the cone
   * frame. `zStart`/`zEnd` are axial-Z bounds; internally converted to slant V.
   */
  static makeConicalHelix(
    cs: CoordinateSystem,
    semiAngle: number,
    refRadius: number,
    zStart: number,
    zEnd: number,
    turns: number,
  ): Edge {
    const oc = getOC();
    const [ax3, disposeAx3] = Convert.toGpAx3(cs);

    const conSurf = new oc.Geom_ConicalSurface(ax3, semiAngle, refRadius);
    const surfHandle = new oc.Handle_Geom_Surface(conSurf);

    const cosA = Math.cos(semiAngle);
    const vStart = zStart / cosA;
    const vEnd = zEnd / cosA;
    const angle = 2 * Math.PI * turns;

    const edge = HelixOps.buildHelixEdgeFromUV(
      surfHandle, 0, vStart, angle, vEnd,
    );

    surfHandle.delete();
    conSurf.delete();
    disposeAx3();

    return edge;
  }

  /**
   * Build an edge from a straight 2D segment in the surface's UV space.
   * Builds a `Geom2d_Line` (rather than `GCE2d_MakeSegment`, whose `GCE2d_Root`
   * base class is not currently bound) and trims it via the parameter range.
   */
  private static buildHelixEdgeFromUV(
    surfaceHandle: any,
    uStart: number, vStart: number,
    uEnd: number, vEnd: number,
  ): Edge {
    const oc = getOC();

    const du = uEnd - uStart;
    const dv = vEnd - vStart;
    const length = Math.sqrt(du * du + dv * dv);

    const origin = new oc.gp_Pnt2d(uStart, vStart);
    const dir = new oc.gp_Dir2d(du / length, dv / length);
    const line2d = new oc.Geom2d_Line(origin, dir);
    const curveHandle = new oc.Handle_Geom2d_Curve(line2d);

    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(curveHandle, surfaceHandle, 0, length);

    if (!edgeMaker.IsDone()) {
      const status = edgeMaker.Error();
      edgeMaker.delete();
      curveHandle.delete();
      line2d.delete();
      origin.delete();
      dir.delete();
      throw new Error("HelixOps: failed to build helix edge: " + status);
    }

    const rawEdge = edgeMaker.Edge();

    // MakeEdge(pcurve, surface) only attaches a parametric curve; downstream
    // sweeps/booleans/meshing need a 3D curve. BuildCurves3d adds it.
    oc.BRepLib.BuildCurves3d(rawEdge);

    // Rebuild the edge from just the 3D curve to drop the pcurve-on-surface.
    // BRepOffsetAPI_MakePipe inspects the spine's pcurve and uses the host
    // surface as a binormal/orientation guide — that constrains the swept
    // profile to slide along the surface tangentially instead of being
    // transported along the pure 3D path. For our case (helix on cylinder),
    // we want the latter so the resulting tube can intersect the cylinder
    // volumetrically (otherwise downstream `.add()`/`.remove()` are no-ops).
    const curve3dHandle = oc.BRep_Tool.Curve(rawEdge, 0, 1);
    const cleanEdgeMaker = new oc.BRepBuilderAPI_MakeEdge(curve3dHandle);
    const cleanEdge = cleanEdgeMaker.Edge();
    cleanEdgeMaker.delete();
    curve3dHandle.delete();

    edgeMaker.delete();
    curveHandle.delete();
    line2d.delete();
    origin.delete();
    dir.delete();

    return Edge.fromTopoDSEdge(cleanEdge);
  }
}
