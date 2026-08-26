// Base of the solved-mode entity features (SolvedPoint/Line/Arc/Circle):
// registration into the owning sketch's solver system at statement time,
// solved-param reads at build time (triggering the per-render solve), and
// the LazyVertex-compatible point accessors the constraint layer consumes.

import { GeometrySceneObject } from "../geometry.js";
import { Sketch } from "../sketch.js";
import { SketchSolverContext } from "./solver-context.js";
import { SolvedPointRef } from "./refs.js";
import { BuildError } from "../../../common/build-error.js";
import { Point2D } from "../../../math/point.js";
import type { EntityKind, PointRole, SolverRef } from "../../../sketch-solver/index.js";
import type { SketchInteractivity } from "../../../rendering/scene.js";

export type SolvedPointRole = PointRole | 'mid';

export abstract class SolvedGeometryBase extends GeometrySceneObject {

  private _ctx: SketchSolverContext | null = null;
  private _entityId = -1;

  abstract get solverKind(): EntityKind;

  /** Called by the command factory right after addSceneObject — the sketch
   * is the active container, so registration order is statement order. */
  register(sk: Sketch): void {
    const ctx = sk.solver();
    if (!ctx) {
      return;
    }
    this._ctx = ctx;
    this._entityId = this.registerInto(ctx);
  }

  protected abstract registerInto(ctx: SketchSolverContext): number;

  get entityId(): number {
    return this._entityId;
  }

  /** Solver ref naming the whole entity. */
  ref(): SolverRef {
    this.requireContext();
    return { entity: this._entityId };
  }

  protected requireContext(): SketchSolverContext {
    if (!this._ctx || this._entityId < 0) {
      throw new BuildError(
        `${this.getType()}() must be written inside a sketch`,
        'wrap the statement in sketch(plane, callback)',
      );
    }
    return this._ctx;
  }

  /**
   * This entity's current solver params — triggers the sketch's one solve
   * per render, then reads the solved values. Also surfaces any
   * diagnose-derived error attributed to this statement (e.g. an arc whose
   * internal consistency rows sit in a conflicting group).
   */
  protected solvedParams(): number[] {
    const sk = this.sketch;
    if (sk) {
      sk.ensureSolvedForBuild();
    }
    const ctx = this.requireContext();
    const error = ctx.statementError(this);
    if (error) {
      this.setError(error);
    }
    return ctx.entityParams(this._entityId);
  }

  /** Current value of one of this entity's named points (guesses until the
   * solve has run). */
  abstract pointValue(role: SolvedPointRole): Point2D;

  protected pointRef(role: SolvedPointRole): SolvedPointRef {
    return new SolvedPointRef(this, role, this.generateUniqueName(`ref-${role}`));
  }

  protected copySolvedStateTo(copy: SolvedGeometryBase): void {
    copy._ctx = this._ctx;
    copy._entityId = this._entityId;
  }

  protected compareSolvedTo(other: SolvedGeometryBase): boolean {
    return this._entityId === other._entityId;
  }

  /** Solved entities drag through the UI's solver client (P4); fixed
   * reference geometry (P6 project()/intersect() outputs) stays pick-only. */
  override getSketchInteractivity(): SketchInteractivity {
    return 'draggable';
  }
}
