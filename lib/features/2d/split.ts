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
 * The solved geometry of an entity the sketch Split and Trim tools may cut,
 * in sketch-local coordinates — what the UI reads off the render payload
 * (`SolvedEntityView`), never the statement's literals.
 */
export type SplittableEntity =
  | { kind: "line"; start: SplitPoint; end: SplitPoint }
  | { kind: "arc"; start: SplitPoint; end: SplitPoint; center: SplitPoint; cw: boolean }
  | { kind: "circle"; center: SplitPoint; radius: number };

/**
 * One piece of a cut, in the entity's travel order (start → end; counter-
 * clockwise from the first cut point around a circle). A circle cut nowhere
 * stays a circle — the whole-entity piece the Trim tool deletes.
 */
export type SplitPiece =
  | { kind: "line"; start: SplitPoint; end: SplitPoint }
  | { kind: "arc"; start: SplitPoint; end: SplitPoint; center: SplitPoint; cw: boolean }
  | { kind: "circle"; center: SplitPoint; radius: number };

export type SplitOutcome = {
  /** Two pieces for a line or an arc; one full-turn arc for a circle. */
  pieces: SplitPiece[];
  /** The split point — the projection of the requested point onto the entity. */
  at: SplitPoint;
};

/** A cut the kernel declines (a point sits at an end, two cuts coincide, the entity is degenerate). */
export class SplitRefusal extends Error {}

/**
 * The kernel side of the sketch Split and Trim tools: project the requested
 * points onto the entity (`BRepExtrema_DistShapeShape` against the entity's
 * edge), then cut the edge there. A line cut at n points yields n + 1 lines,
 * an arc n + 1 arcs around the same center (each keeping the sweep side), a
 * circle n arcs running counter-clockwise from the first cut point — or,
 * cut at a single point, one arc whose start and end coincide there: a full
 * turn the arc entity renders as a circle until one of its ends is moved
 * (see `fitArcThroughEndpoints`).
 *
 * The pieces are re-read from the OCC edges the kernel builds for them, so
 * what the statement transforms write is what the kernel would build. Only
 * the cut positions are rounded downstream (2dp source literals), which is
 * why a cut closer than {@link MIN_PIECE} to an end or to another cut
 * refuses: the rounded piece would collapse.
 */
export class SketchEntitySplit {
  /** A piece shorter than the 2dp source resolution collapses once written. */
  private static readonly MIN_PIECE = 0.01;

  /** The Split tool: one cut where `near` projects onto the entity. */
  static split(entity: SplittableEntity, near: SplitPoint): SplitOutcome {
    const edge = SketchEntitySplit.makeEdge(entity);
    try {
      const at = SketchEntitySplit.project(edge, near);
      return { at, pieces: SketchEntitySplit.cutAt(entity, [at]) };
    } finally {
      edge.delete();
    }
  }

  /**
   * The entity cut at every point of `at` (each projected onto it first),
   * in travel order. No points: the entity itself as its one piece.
   */
  static cut(entity: SplittableEntity, at: SplitPoint[]): SplitPiece[] {
    const edge = SketchEntitySplit.makeEdge(entity);
    try {
      return SketchEntitySplit.cutAt(entity, at.map(p => SketchEntitySplit.project(edge, p)));
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

  /** The cut for points already on the entity. */
  private static cutAt(entity: SplittableEntity, at: SplitPoint[]): SplitPiece[] {
    switch (entity.kind) {
      case "line":
        return SketchEntitySplit.cutLine(entity, at);
      case "arc":
        return SketchEntitySplit.cutArc(entity, at);
      case "circle":
        return SketchEntitySplit.cutCircle(entity, at);
    }
  }

  private static cutLine(entity: Extract<SplittableEntity, { kind: "line" }>, at: SplitPoint[]): SplitPiece[] {
    const dir = [entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]];
    const along = (p: SplitPoint): number => (p[0] - entity.start[0]) * dir[0] + (p[1] - entity.start[1]) * dir[1];
    const cuts = [...at].sort((a, b) => along(a) - along(b));
    const stops = SketchEntitySplit.stops(entity.start, cuts, entity.end);
    const pieces: SplitPiece[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const { start, end } = SketchEntitySplit.readEnds(SketchEntitySplit.makeLineEdge(stops[i], stops[i + 1]));
      pieces.push({ kind: "line", start, end });
    }
    return pieces;
  }

  private static cutArc(entity: Extract<SplittableEntity, { kind: "arc" }>, at: SplitPoint[]): SplitPiece[] {
    const cuts = [...at].sort((a, b) =>
      SketchEntitySplit.travelAngle(entity, a) - SketchEntitySplit.travelAngle(entity, b));
    const stops = SketchEntitySplit.stops(entity.start, cuts, entity.end);
    const radius = SketchEntitySplit.distance(entity.center, entity.start);
    const pieces: SplitPiece[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const { start, end } = SketchEntitySplit.readEnds(
        SketchEntitySplit.makeArcEdge(entity.center, radius, entity.cw, stops[i], stops[i + 1]),
      );
      pieces.push({ kind: "arc", start, end, center: entity.center, cw: entity.cw });
    }
    return pieces;
  }

  /**
   * A circle's pieces run counter-clockwise from the first cut point; one
   * cut is a full-turn arc, none leaves the circle whole.
   */
  private static cutCircle(entity: Extract<SplittableEntity, { kind: "circle" }>, at: SplitPoint[]): SplitPiece[] {
    if (at.length === 0) {
      return [{ kind: "circle", center: entity.center, radius: entity.radius }];
    }
    if (at.length === 1) {
      return [{ kind: "arc", start: at[0], end: at[0], center: entity.center, cw: false }];
    }
    const seam = at[0];
    const ccwFromSeam = (p: SplitPoint): number => {
      const a = Math.atan2(p[1] - entity.center[1], p[0] - entity.center[0])
        - Math.atan2(seam[1] - entity.center[1], seam[0] - entity.center[0]);
      return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    };
    const cuts = [seam, ...at.slice(1).sort((a, b) => ccwFromSeam(a) - ccwFromSeam(b))];
    const stops = SketchEntitySplit.stops(seam, cuts.slice(1), seam);
    const pieces: SplitPiece[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const { start, end } = SketchEntitySplit.readEnds(
        SketchEntitySplit.makeArcEdge(entity.center, entity.radius, false, stops[i], stops[i + 1]),
      );
      pieces.push({ kind: "arc", start, end, center: entity.center, cw: false });
    }
    return pieces;
  }

  /**
   * The piece boundaries `start, …cuts, end`, refusing a cut that would
   * leave a piece shorter than {@link MIN_PIECE} — at an end, or on top of
   * another cut.
   */
  private static stops(start: SplitPoint, cuts: SplitPoint[], end: SplitPoint): SplitPoint[] {
    const floor = mmTol(SketchEntitySplit.MIN_PIECE);
    const stops = [start, ...cuts, end];
    for (let i = 1; i < stops.length; i++) {
      if (SketchEntitySplit.distance(stops[i - 1], stops[i]) < floor) {
        throw new SplitRefusal(i === 1 || i === stops.length - 1
          ? "the cut point sits at the edge's end — click along the edge body"
          : "two cut points coincide — nothing lies between them");
      }
    }
    return stops;
  }

  /** How far around the arc (radians, along its sweep) a point on it lies from the start. */
  private static travelAngle(entity: Extract<SplittableEntity, { kind: "arc" }>, p: SplitPoint): number {
    const a0 = Math.atan2(entity.start[1] - entity.center[1], entity.start[0] - entity.center[0]);
    const a = Math.atan2(p[1] - entity.center[1], p[0] - entity.center[0]);
    const rel = ((a - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return entity.cw ? (2 * Math.PI - rel) % (2 * Math.PI) : rel;
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
        throw new SplitRefusal("the cut point could not be projected onto the edge");
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
