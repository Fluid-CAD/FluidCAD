import { Point2D } from "../../../math/point.js";
import { Vertex } from "../../../common/vertex.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Geometry } from "../../../oc/geometry.js";
import { SketchSolverContext } from "./solver-context.js";
import { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";
import { SolvedPointRef } from "./refs.js";
import type { EntityKind } from "../../../sketch-solver/index.js";

export class SolvedLine extends SolvedGeometryBase {

  constructor(private startGuess: Point2D, private endGuess: Point2D) {
    super();
  }

  get solverKind(): EntityKind {
    return 'line';
  }

  protected registerInto(ctx: SketchSolverContext): number {
    return ctx.addLine(
      this,
      this.startGuess.x, this.startGuess.y,
      this.endGuess.x, this.endGuess.y,
    );
  }

  pointValue(role: SolvedPointRole): Point2D {
    const [sx, sy, ex, ey] = this.requireContext().entityParams(this.entityId);
    switch (role) {
      case 'start':
        return new Point2D(sx, sy);
      case 'end':
        return new Point2D(ex, ey);
      case 'mid':
        return new Point2D((sx + ex) / 2, (sy + ey) / 2);
      default:
        throw new Error(`line has no '${role}' point`);
    }
  }

  build(): void {
    const [sx, sy, ex, ey] = this.solvedParams();
    const plane = this.sketch.getPlane();
    const start = new Point2D(sx, sy);
    const end = new Point2D(ex, ey);

    const segment = Geometry.makeSegment(plane.localToWorld(start), plane.localToWorld(end));
    this.addShape(Geometry.makeEdge(segment));

    this.setState('start', Vertex.fromPoint2D(start));
    this.setState('end', Vertex.fromPoint2D(end));
    this.setTangent(end.subtract(start).normalize());
    this.setState('solved', { start: { x: sx, y: sy }, end: { x: ex, y: ey } });
  }

  override start(): SolvedPointRef {
    return this.pointRef('start');
  }

  override end(): SolvedPointRef {
    return this.pointRef('end');
  }

  /** Midpoint accessor — resolvable as a plain vertex anywhere; in
   * constraints it is only accepted by coincident(), which lowers it to the
   * midpoint constraint. */
  mid(): SolvedPointRef {
    return this.pointRef('mid');
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SolvedLine(this.startGuess, this.endGuess);
    this.copySolvedStateTo(copy);
    return copy;
  }

  compareTo(other: SolvedLine): boolean {
    if (!(other instanceof SolvedLine)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.startGuess.x === other.startGuess.x
      && this.startGuess.y === other.startGuess.y
      && this.endGuess.x === other.endGuess.x
      && this.endGuess.y === other.endGuess.y
      && this.compareSolvedTo(other);
  }

  getType(): string {
    return 'line';
  }

  getUniqueType(): string {
    return 'solved-line';
  }

  serialize() {
    const solved = this.getState('solved') as
      { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
    return {
      entityId: this.entityId,
      start: solved?.start ?? { x: this.startGuess.x, y: this.startGuess.y },
      end: solved?.end ?? { x: this.endGuess.x, y: this.endGuess.y },
    };
  }
}
