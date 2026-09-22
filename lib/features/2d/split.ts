import type { gp_Ax2, gp_Circ, TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { Convert } from "../../oc/convert.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point, Point2D } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { mmTol } from "../../units/tolerance.js";

/** A sketch-local position, `[x, y]`. */
export type SplitPoint = [number, number];

/**
 * The solved geometry of an entity the sketch Split tool may cut, in
 * sketch-local coordinates — what the UI reads off the render payload
 * (`SolvedEntityView`), never the statement's literals.
 */
export type SplittableEntity =
  | { kind: "line"; start: SplitPoint; end: SplitPoint }
  | { kind: "arc"; start: SplitPoint; end: SplitPoint; center: SplitPoint; cw: boolean }
  | { kind: "circle"; center: SplitPoint; radius: number };

/** One piece of a split, in the entity's travel order (start → end). */
export type SplitPiece =
  | { kind: "line"; start: SplitPoint; end: SplitPoint }
  | { kind: "arc"; start: SplitPoint; end: SplitPoint; center: SplitPoint; cw: boolean };

export type SplitOutcome = {
  /** Two pieces for a line or an arc; one full-turn arc for a circle. */
  pieces: SplitPiece[];
  /** The split point — the projection of the requested point onto the entity. */
  at: SplitPoint;
};

/** A split the kernel declines (the point sits at an end, the entity is degenerate). */
export class SplitRefusal extends Error {}

/**
 * The sketch Split tool's geometry, computed by the kernel: project the
 * clicked point onto the entity (`BRepExtrema_DistShapeShape` against the
 * entity's edge), then cut the edge there. A line yields two lines, an arc
 * two arcs around the same center (each keeping the sweep side), a circle a
 * single arc whose start and end coincide at the split point — a full turn
 * the arc entity renders as a circle until one of its ends is moved (see
 * `fitArcThroughEndpoints`).
 *
 * The pieces are re-read from the OCC edges the kernel builds for them, so
 * what the statement transform writes is what the kernel would build. Only
 * the split position is rounded downstream (2dp source literals), which is
 * why a cut closer than {@link MIN_PIECE} to an end refuses: the rounded
 * piece would collapse.
 */
export class SketchEntitySplit {
  /** A piece shorter than the 2dp source resolution collapses once written. */
  private static readonly MIN_PIECE = 0.01;

  static split(entity: SplittableEntity, near: SplitPoint): SplitOutcome {
    const edge = SketchEntitySplit.makeEdge(entity);
    try {
      const at = SketchEntitySplit.project(edge, near);
      switch (entity.kind) {
        case "line":
          return { at, pieces: SketchEntitySplit.cutLine(entity, at) };
        case "arc":
          return { at, pieces: SketchEntitySplit.cutArc(entity, at) };
        case "circle":
          return { at, pieces: [{ kind: "arc", start: at, end: at, center: entity.center, cw: false }] };
      }
    } finally {
      edge.delete();
    }
  }

  /**
   * Which piece a point touches — the one whose edge is nearest. Decides
   * which piece keeps a constraint that acts at a position along the
   * original entity (a point on it, a tangency).
   */
  static nearestPiece(pieces: SplitPiece[], point: SplitPoint): number {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    pieces.forEach((piece, index) => {
      const edge = SketchEntitySplit.makeEdge(piece);
      try {
        const distance = SketchEntitySplit.distanceTo(edge, point);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      } finally {
        edge.delete();
      }
    });
    return best;
  }

  private static cutLine(entity: Extract<SplittableEntity, { kind: "line" }>, at: SplitPoint): SplitPiece[] {
    SketchEntitySplit.assertInterior(entity.start, entity.end, at);
    const first = SketchEntitySplit.readEnds(SketchEntitySplit.makeLineEdge(entity.start, at));
    const second = SketchEntitySplit.readEnds(SketchEntitySplit.makeLineEdge(at, entity.end));
    return [
      { kind: "line", start: first.start, end: first.end },
      { kind: "line", start: second.start, end: second.end },
    ];
  }

  private static cutArc(entity: Extract<SplittableEntity, { kind: "arc" }>, at: SplitPoint): SplitPiece[] {
    SketchEntitySplit.assertInterior(entity.start, entity.end, at);
    const radius = SketchEntitySplit.distance(entity.center, entity.start);
    const first = SketchEntitySplit.readEnds(
      SketchEntitySplit.makeArcEdge(entity.center, radius, entity.cw, entity.start, at),
    );
    const second = SketchEntitySplit.readEnds(
      SketchEntitySplit.makeArcEdge(entity.center, radius, entity.cw, at, entity.end),
    );
    return [
      { kind: "arc", start: first.start, end: first.end, center: entity.center, cw: entity.cw },
      { kind: "arc", start: second.start, end: second.end, center: entity.center, cw: entity.cw },
    ];
  }

  private static assertInterior(start: SplitPoint, end: SplitPoint, at: SplitPoint): void {
    const floor = mmTol(SketchEntitySplit.MIN_PIECE);
    if (SketchEntitySplit.distance(start, at) < floor || SketchEntitySplit.distance(end, at) < floor) {
      throw new SplitRefusal("the split point sits at the edge's end — click along the edge body");
    }
  }

  private static makeEdge(entity: SplittableEntity | SplitPiece): TopoDS_Edge {
    switch (entity.kind) {
      case "line":
        return SketchEntitySplit.makeLineEdge(entity.start, entity.end);
      case "arc":
        return SketchEntitySplit.makeArcEdge(
          entity.center, SketchEntitySplit.distance(entity.center, entity.start), entity.cw, entity.start, entity.end,
        );
      case "circle": {
        const oc = getOC();
        const [circle, dispose] = SketchEntitySplit.makeCircle(entity.center, entity.radius, false);
        const maker = new oc.BRepBuilderAPI_MakeEdge(circle);
        try {
          return SketchEntitySplit.takeEdge(maker, "circle");
        } finally {
          maker.delete();
          dispose();
        }
      }
    }
  }

  private static makeLineEdge(start: SplitPoint, end: SplitPoint): TopoDS_Edge {
    const oc = getOC();
    const [a, disposeA] = Convert.toGpPnt(SketchEntitySplit.point3d(start));
    const [b, disposeB] = Convert.toGpPnt(SketchEntitySplit.point3d(end));
    const maker = new oc.BRepBuilderAPI_MakeEdge(a, b);
    try {
      return SketchEntitySplit.takeEdge(maker, "line");
    } finally {
      maker.delete();
      disposeA();
      disposeB();
    }
  }

  /**
   * An arc of the circle around `center`, from `start` to `end`. The circle's
   * axis follows the sweep side (−Z for clockwise), so the edge's parameter
   * runs along the arc's travel direction and OCC picks the sweep the sketch
   * shows rather than the shorter one.
   */
  private static makeArcEdge(
    center: SplitPoint, radius: number, cw: boolean, start: SplitPoint, end: SplitPoint,
  ): TopoDS_Edge {
    const oc = getOC();
    const [circle, dispose] = SketchEntitySplit.makeCircle(center, radius, cw);
    const [a, disposeA] = Convert.toGpPnt(SketchEntitySplit.point3d(start));
    const [b, disposeB] = Convert.toGpPnt(SketchEntitySplit.point3d(end));
    const maker = new oc.BRepBuilderAPI_MakeEdge(circle, a, b);
    try {
      return SketchEntitySplit.takeEdge(maker, "arc");
    } finally {
      maker.delete();
      disposeA();
      disposeB();
      dispose();
    }
  }

  private static makeCircle(center: SplitPoint, radius: number, cw: boolean): [gp_Circ, () => void] {
    const oc = getOC();
    const [c, disposeC] = Convert.toGpPnt(SketchEntitySplit.point3d(center));
    const [n, disposeN] = Convert.toGpDir(new Vector3d(0, 0, cw ? -1 : 1));
    const ax2: gp_Ax2 = new oc.gp_Ax2(c, n);
    const circle: gp_Circ = new oc.gp_Circ(ax2, radius);
    return [circle, () => {
      circle.delete();
      ax2.delete();
      disposeN();
      disposeC();
    }];
  }

  private static takeEdge(maker: { IsDone(): boolean; Edge(): TopoDS_Edge }, what: string): TopoDS_Edge {
    if (!maker.IsDone()) {
      throw new SplitRefusal(`the ${what} is degenerate — its ends coincide`);
    }
    return maker.Edge();
  }

  /** The nearest point of `edge` to `near`. */
  private static project(edge: TopoDS_Edge, near: SplitPoint): SplitPoint {
    const oc = getOC();
    const [p, disposeP] = Convert.toGpPnt(SketchEntitySplit.point3d(near));
    const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(p);
    const vertex = vertexMaker.Vertex();
    const progress = new oc.Message_ProgressRange();
    const extrema = new oc.BRepExtrema_DistShapeShape(
      vertex, edge, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
    );
    try {
      if (!extrema.IsDone() || extrema.NbSolution() < 1) {
        throw new SplitRefusal("the split point could not be projected onto the edge");
      }
      const foot = extrema.PointOnShape2(1);
      const at: SplitPoint = [foot.X(), foot.Y()];
      foot.delete();
      return at;
    } finally {
      extrema.delete();
      progress.delete();
      vertex.delete();
      vertexMaker.delete();
      disposeP();
    }
  }

  private static distanceTo(edge: TopoDS_Edge, point: SplitPoint): number {
    const oc = getOC();
    const [p, disposeP] = Convert.toGpPnt(SketchEntitySplit.point3d(point));
    const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(p);
    const vertex = vertexMaker.Vertex();
    const progress = new oc.Message_ProgressRange();
    const extrema = new oc.BRepExtrema_DistShapeShape(
      vertex, edge, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
    );
    try {
      return extrema.IsDone() ? extrema.Value() : Number.POSITIVE_INFINITY;
    } finally {
      extrema.delete();
      progress.delete();
      vertex.delete();
      vertexMaker.delete();
      disposeP();
    }
  }

  /** The endpoints of an OCC edge, in its own orientation; the edge is consumed. */
  private static readEnds(edge: TopoDS_Edge): { start: SplitPoint; end: SplitPoint } {
    try {
      const first = EdgeOps.getFirstVertexRaw(edge);
      const last = EdgeOps.getLastVertexRaw(edge);
      const start = EdgeOps.getVertexPointRaw(first);
      const end = EdgeOps.getVertexPointRaw(last);
      first.delete();
      last.delete();
      return { start: [start.x, start.y], end: [end.x, end.y] };
    } finally {
      edge.delete();
    }
  }

  private static point3d(p: SplitPoint): Point {
    return new Point(p[0], p[1], 0);
  }

  private static distance(a: SplitPoint, b: SplitPoint): number {
    return new Point2D(a[0], a[1]).distanceTo(new Point2D(b[0], b[1]));
  }
}
