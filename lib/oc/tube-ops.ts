import type { TopoDS_Edge, TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import type { Edge } from "../common/edge.js";
import type { Wire } from "../common/wire.js";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { EdgeOps } from "./edge-ops.js";
import { PathSampler } from "./path-sampler.js";
import { WireOps } from "./wire-ops.js";
import { mmTol } from "../units/tolerance.js";

/**
 * Tubes round curves: the points at one distance from a curve, as a surface.
 * The offset curve meets its faces with one (`offset(d, edges, { on })`).
 */
export class TubeOps {
  /**
   * An open tube of `radius` round `wire`: a shell, with no caps, rounded
   * at the wire's corners. Its two ends are the circles square to the wire
   * at its ends; round a closed wire it closes on itself.
   *
   * A circle at the wire's start, square to it there, is swept along the
   * wire (`BRepOffsetAPI_MakePipeShell`) with the round-corner transition:
   * at a corner the circle turns about the corner, so the wall stays closed
   * on the outside, as the arc joins of a 2D offset do, and the kernel trims
   * the walls where they overlap on the inside. A circle does not care how
   * the frame twists along the wire, so the default trihedron serves. The
   * kernel keeps the analytic cases analytic: round a line the tube is a
   * cylinder, round a circle a torus, round a corner a surface of
   * revolution.
   *
   * A wire of one closed edge whose parameters do not start at zero — a
   * projected circle's do not — is swept along its two halves: round such
   * an edge the kernel marks the tube's seam as degenerate, and the section
   * of that tube with anything is garbage.
   *
   * A sweep the kernel cannot finish is refused with an `Error`. The shape
   * is the caller's to delete.
   */
  static around(wire: Wire, radius: number): TopoDS_Shape {
    if (!(radius > 0)) {
      throw new Error(`TubeOps.around: the radius must be positive, got ${radius}.`);
    }
    const spine = TubeOps.spineOf(wire);
    try {
      return TubeOps.sweep(spine, radius);
    } finally {
      if (spine !== wire) {
        spine.dispose();
      }
    }
  }

  /**
   * The wire the circle is swept along: `wire`, or for one closed edge whose
   * parameters do not start at zero, a new wire of its two halves.
   */
  private static spineOf(wire: Wire): Wire {
    const edges = wire.getEdges();
    if (edges.length !== 1 || !EdgeOps.isClosed(edges[0]) || TubeOps.firstParameter(edges[0]) === 0) {
      return wire;
    }
    const { pieces } = EdgeOps.splitEdgeAtMid(edges[0]);
    try {
      return WireOps.makeWireFromEdges(pieces);
    } finally {
      pieces.forEach(piece => piece.dispose());
    }
  }

  /** Where an edge's parameters start, in its curve's own parameter. */
  private static firstParameter(edge: Edge): number {
    const adaptor = new (getOC().BRepAdaptor_Curve)(edge.getShape() as TopoDS_Edge);
    try {
      return adaptor.FirstParameter();
    } finally {
      adaptor.delete();
    }
  }

  private static sweep(wire: Wire, radius: number): TopoDS_Shape {
    const oc = getOC();
    const sampler = new PathSampler(wire);
    let start;
    try {
      start = sampler.evalAt(0);
    } finally {
      sampler.dispose();
    }

    const [center, disposeCenter] = Convert.toGpPnt(start.point);
    const [axis, disposeAxis] = Convert.toGpDir(start.tangent);
    const placement = new oc.gp_Ax2(center, axis);
    const circle = new oc.gp_Circ(placement, radius);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(circle);
    const edge = edgeMaker.Edge();
    const wireMaker = new oc.BRepBuilderAPI_MakeWire(edge);
    const profile = wireMaker.Wire();
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(wire.getShape() as TopoDS_Wire);
    const progress = new oc.Message_ProgressRange();
    try {
      pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
      // Approximation tolerances are lengths: the kernel's defaults, read in
      // millimetres. unit: angular for the last.
      pipe.SetTolerance(mmTol(1e-4), mmTol(1e-4), 1e-2);
      // The circle is squared to the wire (WithCorrection), which the round
      // corners need; it sits on the wire already (no contact translation).
      pipe.Add(profile, false, true);
      try {
        pipe.Build(progress);
      } catch (cause) {
        throw new Error(`TubeOps.around: the kernel could not sweep the tube (${String(cause)}).`);
      }
      if (!pipe.IsDone()) {
        throw new Error(`TubeOps.around: the kernel could not sweep the tube (${pipe.GetStatus()}).`);
      }
      return pipe.Shape();
    } finally {
      progress.delete();
      pipe.delete();
      profile.delete();
      wireMaker.delete();
      edge.delete();
      edgeMaker.delete();
      circle.delete();
      placement.delete();
      disposeAxis();
      disposeCenter();
    }
  }
}
