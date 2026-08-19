import { Point2D } from "../../../math/point.js";
import { Vertex } from "../../../common/vertex.js";
import { SceneObject } from "../../../common/scene-object.js";
import { fitArcThroughEndpoints } from "../arc-fit.js";
import { SketchSolverContext } from "./solver-context.js";
import { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";
import { SolvedPointRef } from "./refs.js";
import type { EntityKind } from "../../../sketch-solver/index.js";

export class SolvedArc extends SolvedGeometryBase {

  private _clockwise = false;

  constructor(
    private startGuess: Point2D,
    private endGuess: Point2D,
    private centerGuess: Point2D,
  ) {
    super();
  }

  get solverKind(): EntityKind {
    return 'arc';
  }

  protected registerInto(ctx: SketchSolverContext): number {
    return ctx.addArc(
      this,
      this.centerGuess.x, this.centerGuess.y,
      this.startGuess.x, this.startGuess.y,
      this.endGuess.x, this.endGuess.y,
    );
  }

  /** The sweep side from start to end; default is counter-clockwise. The
   * solver has no sweep param — this is pure display/topology choice. */
  cw(): this {
    this._clockwise = true;
    return this;
  }

  ccw(): this {
    this._clockwise = false;
    return this;
  }

  pointValue(role: SolvedPointRole): Point2D {
    const [cx, cy, , sx, sy, ex, ey] = this.requireContext().entityParams(this.entityId);
    switch (role) {
      case 'center':
        return new Point2D(cx, cy);
      case 'start':
        return new Point2D(sx, sy);
      case 'end':
        return new Point2D(ex, ey);
      default:
        throw new Error(`arc has no '${role}' point`);
    }
  }

  build(): void {
    const [cx, cy, r, sx, sy, ex, ey] = this.solvedParams();
    const plane = this.sketch.getPlane();
    const start = new Point2D(sx, sy);
    const end = new Point2D(ex, ey);
    const center = new Point2D(cx, cy);

    const { edge, actualCenter, endTangent } = fitArcThroughEndpoints(
      plane, start, end, center, this._clockwise,
    );

    const centerVertex = Vertex.fromPoint(plane.localToWorld(actualCenter));
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
    this.addShape(edge);

    this.setState('start', Vertex.fromPoint2D(start));
    this.setState('end', Vertex.fromPoint2D(end));
    this.setTangent(endTangent);
    this.setState('solved', {
      center: { x: cx, y: cy },
      radius: r,
      start: { x: sx, y: sy },
      end: { x: ex, y: ey },
    });
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
    const copy = new SolvedArc(this.startGuess, this.endGuess, this.centerGuess);
    copy._clockwise = this._clockwise;
    this.copySolvedStateTo(copy);
    return copy;
  }

  compareTo(other: SolvedArc): boolean {
    if (!(other instanceof SolvedArc)) {
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
      && this._clockwise === other._clockwise
      && this.compareSolvedTo(other);
  }

  getType(): string {
    return 'arc';
  }

  getUniqueType(): string {
    return 'solved-arc';
  }

  serialize() {
    const solved = this.getState('solved') as {
      center: { x: number; y: number };
      radius: number;
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | undefined;
    return {
      entityId: this.entityId,
      cw: this._clockwise,
      center: solved?.center ?? { x: this.centerGuess.x, y: this.centerGuess.y },
      radius: solved?.radius,
      start: solved?.start ?? { x: this.startGuess.x, y: this.startGuess.y },
      end: solved?.end ?? { x: this.endGuess.x, y: this.endGuess.y },
      // Statement-time argument values: the drag write-back drift-guards its
      // literal splices against these (P4).
      guess: {
        start: { x: this.startGuess.x, y: this.startGuess.y },
        end: { x: this.endGuess.x, y: this.endGuess.y },
        center: { x: this.centerGuess.x, y: this.centerGuess.y },
      },
    };
  }
}
