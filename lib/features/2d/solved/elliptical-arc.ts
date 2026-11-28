import { Point2D } from "../../../math/point.js";
import { Vertex } from "../../../common/vertex.js";
import { SceneObject } from "../../../common/scene-object.js";
import { IEllipticalArc } from "../../../core/interfaces.js";
import { buildEllipseArcEdge } from "../ellipse-edge.js";
import { SketchSolverContext } from "./solver-context.js";
import { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";
import { SolvedPointRef } from "./refs.js";
import { ellipseArcSpan, projectOntoEllipse } from "../../../sketch-solver/index.js";
import type { EllipseFrame, EntityKind } from "../../../sketch-solver/index.js";

const DEG = Math.PI / 180;

type SolvedState = {
  center: { x: number; y: number };
  rx: number;
  ry: number;
  rotation: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
};

/**
 * A solved elliptical arc: an open piece of an ellipse, the solver entity
 * [cx, cy, rx, ry, θ, sx, sy, ex, ey]. It is an ellipse's five params and
 * an arc's two ends at once: the semi-radii and the rotation are guesses
 * the constraints drive exactly like an ellipse's, the ends are points
 * held on the ellipse like an arc's, and the sweep side from start to end
 * is the statement's choice (`.cw()`), not a solver param.
 */
export class SolvedEllipticalArc extends SolvedGeometryBase implements IEllipticalArc {

  private _clockwise = false;

  constructor(
    private startGuess: Point2D,
    private endGuess: Point2D,
    private centerGuess: Point2D,
    /** Semi-radius guesses along the ellipse's RX / RY axes. */
    private rxGuess: number,
    private ryGuess: number,
    /** Rotation guess in degrees; null when the statement gave none (0). */
    private rotationGuess: number | null = null,
  ) {
    super();
  }

  get solverKind(): EntityKind {
    return 'eArc';
  }

  /** The ellipse the statement's literals describe. */
  private guessFrame(): EllipseFrame {
    return {
      cx: this.centerGuess.x,
      cy: this.centerGuess.y,
      rx: this.rxGuess,
      ry: this.ryGuess,
      theta: (this.rotationGuess ?? 0) * DEG,
    };
  }

  /**
   * The ellipse registers exactly as written; each end registers where
   * its literal falls on that ellipse. An end literal says where along
   * the ellipse the arc stops, and it is rarely on the outline to the
   * last digit (rounded coordinates, a hand-written guess), so reading it
   * this way keeps a freshly drawn arc from nudging its own radii just to
   * meet its ends.
   */
  protected registerInto(ctx: SketchSolverContext): number {
    const frame = this.guessFrame();
    const usable = frame.rx > 0 && frame.ry > 0;
    const start = usable
      ? projectOntoEllipse(frame, this.startGuess.x, this.startGuess.y)
      : [this.startGuess.x, this.startGuess.y];
    const end = usable
      ? projectOntoEllipse(frame, this.endGuess.x, this.endGuess.y)
      : [this.endGuess.x, this.endGuess.y];
    return ctx.addEllipticalArc(
      this,
      frame,
      { x: start[0], y: start[1] },
      { x: end[0], y: end[1] },
    );
  }

  /** Sweeps the arc clockwise from start to end; the default is
   * counter-clockwise. The solver has no sweep param: this picks which of
   * the two pieces between the ends is drawn. */
  cw(): this {
    this._clockwise = true;
    return this;
  }

  ccw(): this {
    this._clockwise = false;
    return this;
  }

  pointValue(role: SolvedPointRole): Point2D {
    const [cx, cy, , , , sx, sy, ex, ey] = this.requireContext().entityParams(this.entityId);
    switch (role) {
      case 'center':
        return new Point2D(cx, cy);
      case 'start':
        return new Point2D(sx, sy);
      case 'end':
        return new Point2D(ex, ey);
      default:
        throw new Error(`elliptical arc has no '${role}' point`);
    }
  }

  build(): void {
    if (this.rxGuess <= 0 || this.ryGuess <= 0) {
      throw new Error(`Elliptical arc radii must be positive (rx=${this.rxGuess}, ry=${this.ryGuess})`);
    }

    const [cx, cy, rx, ry, theta, sx, sy, ex, ey] = this.solvedParams();
    if (rx <= 0 || ry <= 0) {
      throw new Error(`Elliptical arc radii solved to a non-positive size (rx=${rx}, ry=${ry}). Check the dimensions on it`);
    }
    const plane = this.sketch.getPlane();
    const span = ellipseArcSpan({ cx, cy, rx, ry, theta }, [sx, sy], [ex, ey], this._clockwise);

    const centerVertex = Vertex.fromPoint(plane.localToWorld(new Point2D(cx, cy)));
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
    this.addShape(buildEllipseArcEdge(plane, span));

    const solved: SolvedState = {
      center: { x: cx, y: cy },
      rx,
      ry,
      rotation: theta / DEG,
      start: { x: sx, y: sy },
      end: { x: ex, y: ey },
    };
    this.setState('solved', solved);
  }

  override start(): SolvedPointRef {
    return this.pointRef('start');
  }

  override end(): SolvedPointRef {
    return this.pointRef('end');
  }

  center(): SolvedPointRef {
    return this.pointRef('center');
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SolvedEllipticalArc(
      this.startGuess, this.endGuess, this.centerGuess,
      this.rxGuess, this.ryGuess, this.rotationGuess,
    );
    copy._clockwise = this._clockwise;
    this.copySolvedStateTo(copy);
    return copy;
  }

  compareTo(other: SolvedEllipticalArc): boolean {
    if (!(other instanceof SolvedEllipticalArc)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.startGuess.x === other.startGuess.x
      && this.startGuess.y === other.startGuess.y
      && this.endGuess.x === other.endGuess.x
      && this.endGuess.y === other.endGuess.y
      && this.centerGuess.x === other.centerGuess.x
      && this.centerGuess.y === other.centerGuess.y
      && this.rxGuess === other.rxGuess
      && this.ryGuess === other.ryGuess
      && this.rotationGuess === other.rotationGuess
      && this._clockwise === other._clockwise
      && this.compareSolvedTo(other);
  }

  getType(): string {
    return 'eArc';
  }

  getUniqueType(): string {
    return 'solved-earc';
  }

  serialize() {
    const solved = this.getState('solved') as SolvedState | undefined;
    return {
      entityId: this.entityId,
      cw: this._clockwise,
      center: solved?.center ?? { x: this.centerGuess.x, y: this.centerGuess.y },
      /** Solved semi-radii along the RX / RY axes. */
      rx: solved?.rx ?? this.rxGuess,
      ry: solved?.ry ?? this.ryGuess,
      /** Solved rotation of the RX axis from the sketch x direction, degrees. */
      rotation: solved?.rotation ?? this.rotationGuess ?? 0,
      start: solved?.start ?? { x: this.startGuess.x, y: this.startGuess.y },
      end: solved?.end ?? { x: this.endGuess.x, y: this.endGuess.y },
      // Statement-time argument values: the drag write-back drift-guards its
      // literal splices against these. `rotation` is present only when the
      // statement carries the last argument; its absence tells the
      // write-back to append one.
      guess: {
        start: { x: this.startGuess.x, y: this.startGuess.y },
        end: { x: this.endGuess.x, y: this.endGuess.y },
        center: { x: this.centerGuess.x, y: this.centerGuess.y },
        rx: this.rxGuess,
        ry: this.ryGuess,
        ...(this.rotationGuess !== null ? { rotation: this.rotationGuess } : {}),
      },
    };
  }
}
