// Solver participation for statements that are not solver entities
// themselves (ellipse, bezier, text): their POSITION params — the ellipse
// center, each literal bezier control point, the text anchor — register as
// plain solver POINT entities owned by the statement, so constraints can
// target them, the solve moves them, and the build reads the solved
// positions. Shape params (radii, glyph outlines, curve degree) stay
// literals outside the solve.

import { LazyVertex } from "../../lazy-vertex.js";
import { Vertex } from "../../../common/vertex.js";
import { Point2D } from "../../../math/point.js";
import type { GeometrySceneObject } from "../geometry.js";
import type { Sketch } from "../sketch.js";
import type { SketchSolverContext } from "./solver-context.js";

/**
 * A constrainable anchor point of a non-entity statement
 * (`el.center()`, `bz.point(i)`, `t.anchor()`): LazyVertex-compatible
 * anywhere a point is accepted (reading the *current* solver params —
 * guesses during module evaluation, solved values after the build's
 * solve), and resolving to its own solver point entity in constraints.
 */
export class AnchorPointRef extends LazyVertex {
  constructor(
    readonly owner: GeometrySceneObject,
    private readonly anchors: StatementAnchors,
    private readonly index: number,
    uniqueName: string,
  ) {
    super(uniqueName, () => [Vertex.fromPoint2D(anchors.value(index))]);
  }

  get entityId(): number {
    return this.anchors.entityId(this.index);
  }
}

/**
 * The anchor-point registry a statement owns: registration into the
 * sketch's solver context at statement time (the factory calls
 * register right after addSceneObject, so registration order is
 * statement order), guess refinement for chained modifiers
 * (`text().at()`), and solved-param reads at build time.
 */
export class StatementAnchors {
  private ctx: SketchSolverContext | null = null;
  private ids: number[] = [];

  register(sk: Sketch, owner: GeometrySceneObject, points: Point2D[]): void {
    const ctx = sk.solver();
    if (!ctx) {
      return;
    }
    this.ctx = ctx;
    for (const p of points) {
      this.ids.push(ctx.addPoint(owner, p.x, p.y));
    }
  }

  get registered(): boolean {
    return this.ctx !== null && this.ids.length > 0;
  }

  get count(): number {
    return this.ids.length;
  }

  entityId(index: number): number {
    this.require(index);
    return this.ids[index];
  }

  /** Statement-time guess refinement (`.at()` chains after the factory
   * registered the default). */
  updateGuess(index: number, p: Point2D): void {
    this.require(index);
    this.ctx.system.setGuess(this.ids[index], [p.x, p.y]);
  }

  /** Current position — guess before the solve, solved value after. */
  value(index: number): Point2D {
    this.require(index);
    const [x, y] = this.ctx.entityParams(this.ids[index]);
    return new Point2D(x, y);
  }

  /**
   * Solved positions for the owner's build: triggers the sketch's one
   * solve per render, surfaces any diagnose-derived error attributed to
   * the statement, then reads the solved values.
   */
  solvedValues(owner: GeometrySceneObject): Point2D[] {
    const sk = owner.sketch;
    if (sk) {
      sk.ensureSolvedForBuild();
    }
    if (this.ctx) {
      const error = this.ctx.statementError(owner);
      if (error) {
        owner.setError(error);
      }
    }
    return this.ids.map((_, i) => this.value(i));
  }

  /** Never throws — an unregistered ref fails at resolution time, where
   * the error stashes on the referencing constraint statement. */
  ref(owner: GeometrySceneObject, index: number, name: string): AnchorPointRef {
    return new AnchorPointRef(owner, this, index, name);
  }

  /** createCopy support — copies share the registration (same render). */
  copyTo(other: StatementAnchors): void {
    other.ctx = this.ctx;
    other.ids = [...this.ids];
  }

  sameAs(other: StatementAnchors): boolean {
    return this.ids.length === other.ids.length
      && this.ids.every((id, i) => id === other.ids[i]);
  }

  private require(index: number): void {
    if (!this.ctx || this.ids.length === 0) {
      throw new Error('this statement is not part of a sketch — write it inside sketch(plane, callback)');
    }
    if (index < 0 || index >= this.ids.length) {
      throw new Error(`anchor point ${index} does not exist`);
    }
  }
}
