import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { LazyVertex } from "../lazy-vertex.js";
import { GeometrySceneObject } from "./geometry.js";
import { StatementAnchors, AnchorPointRef } from "./solved/anchors.js";
import { SolvedPointRef } from "./solved/refs.js";
import { sourceEntitiesPayload, type SourceEntitiesRecord } from "./solved/source-entities.js";
import type { Sketch } from "./sketch.js";

export class BezierCurve extends GeometrySceneObject {

  private anchors = new StatementAnchors();
  /** Control-point index → index into `anchors` (literal args only). */
  private anchorIndexOf = new Map<number, number>();

  constructor(
    public controlPoints: LazyVertex[],
    private literalIndices: number[] = controlPoints.map((_, i) => i),
  ) {
    super();
  }

  /**
   * Called by the command factory right after addSceneObject: every literal
   * control point registers as a solver point entity, so constraints can
   * target `.point(i)` and the solve reshapes the curve. Control points
   * given as other entities' accessors already ride those entities' params.
   */
  register(sk: Sketch): void {
    const points: Point2D[] = [];
    for (const i of this.literalIndices) {
      this.anchorIndexOf.set(i, points.length);
      points.push(this.controlPoints[i].asPoint2D());
    }
    if (points.length > 0) {
      this.anchors.register(sk, this, points);
    }
  }

  /**
   * The i-th control point (0-based; 0 is the start, the last index the
   * end): a literal's own solver anchor point, or — when the argument was
   * another entity's accessor — that original reference.
   */
  point(index: number): LazyVertex {
    if (index < 0 || index >= this.controlPoints.length) {
      throw new Error(
        `bezier: point(${index}) is out of range — this curve has ${this.controlPoints.length} control points`,
      );
    }
    const anchorIndex = this.anchorIndexOf.get(index);
    if (anchorIndex === undefined) {
      return this.controlPoints[index];
    }
    return this.anchors.ref(this, anchorIndex, this.generateUniqueName(`ref-cp-${index}`));
  }

  override start(): LazyVertex {
    return this.point(0);
  }

  override end(): LazyVertex {
    return this.point(this.controlPoints.length - 1);
  }

  /**
   * Solver identity for derived-op sources and the viewport tint join
   * (P8): the curve is a rigid function of its control points — its own
   * anchor entities plus the owners of accessor-valued control points.
   * `allSolved` goes false when any control point carries no solver
   * identity (a bezier outside a sketch); undefined with no points.
   */
  anchorSourceEntities(): SourceEntitiesRecord | undefined {
    if (this.controlPoints.length === 0) {
      return undefined;
    }
    const ids = new Set<number>();
    let allSolved = true;
    for (let i = 0; i < this.controlPoints.length; i++) {
      const anchorIndex = this.anchorIndexOf.get(i);
      if (anchorIndex !== undefined && this.anchors.registered) {
        ids.add(this.anchors.entityId(anchorIndex));
        continue;
      }
      const cp = this.controlPoints[i];
      if (cp instanceof SolvedPointRef) {
        if (cp.owner.entityId >= 0) {
          ids.add(cp.owner.entityId);
        } else {
          allSolved = false;
        }
        continue;
      }
      if (cp instanceof AnchorPointRef) {
        try {
          ids.add(cp.entityId);
          continue;
        } catch {
          // unregistered anchor — no identity
        }
      }
      allSolved = false;
    }
    if (ids.size === 0 && !allSolved) {
      return undefined;
    }
    return { ids: [...ids].sort((a, b) => a - b), allSolved };
  }

  /** Current control-point positions — solved values for literals (the
   * caller must have triggered the solve), resolved accessors otherwise. */
  private currentPoints(): Point2D[] {
    const solved = this.anchors.registered ? this.anchors.solvedValues(this) : null;
    return this.controlPoints.map((cp, i) => {
      const anchorIndex = this.anchorIndexOf.get(i);
      return solved && anchorIndex !== undefined ? solved[anchorIndex] : cp.asPoint2D();
    });
  }

  build(): void {
    const sk = this.enclosingSketch();
    if (sk) {
      sk.ensureSolvedForBuild();
    }
    const points = this.currentPoints();
    if (points.length < 2) {
      // 0 args: interactive placeholder. 1 arg: start placed, no curve yet.
      return;
    }

    const plane = this.sketch.getPlane();

    // Poles: all args in order — first is start, last is endpoint, middle are controls.
    const polesWorld = points.map(p => plane.localToWorld(p));

    const bezierCurve = Geometry.makeBezierCurve(polesWorld);
    const edge = Geometry.makeEdgeFromBezier(bezierCurve);

    this.addShape(edge);
  }

  compareTo(other: BezierCurve): boolean {
    if (!(other instanceof BezierCurve)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.controlPoints.length !== other.controlPoints.length) {
      return false;
    }

    for (let i = 0; i < this.controlPoints.length; i++) {
      if (!this.controlPoints[i].compareTo(other.controlPoints[i])) {
        return false;
      }
    }

    return this.anchors.sameAs(other.anchors);
  }

  getType(): string {
    return 'bezier';
  }

  getUniqueType(): string {
    return `bezier-${this.controlPoints.length}`;
  }

  serialize() {
    const points = this.currentPoints();
    const start = points[0];
    const resolved = points.slice(1).map(p => [p.x, p.y]);
    return {
      controlPoints: this.controlPoints,
      startPoint: start ? [start.x, start.y] : null,
      resolvedPoints: resolved,
      // The tint join: the curve wears its control points' constrained
      // verdict (same rail as copy/mirror duplicates).
      ...sourceEntitiesPayload(this.anchorSourceEntities()),
      // Solver join fields for the literal control points (the UI's
      // statement→entity map + the drag write-back's drift guard),
      // present only inside a sketch.
      ...(this.anchors.registered
        ? {
          anchors: this.literalIndices.map((controlIndex, anchorIndex) => {
            const guess = this.controlPoints[controlIndex].asPoint2D();
            return {
              pointIndex: controlIndex,
              entityId: this.anchors.entityId(anchorIndex),
              guess: { x: guess.x, y: guess.y },
            };
          }),
        }
        : {}),
    };
  }
}
