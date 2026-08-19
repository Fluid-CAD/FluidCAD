import { Point2D } from "../../../math/point.js";
import { Vertex } from "../../../common/vertex.js";
import { SceneObject } from "../../../common/scene-object.js";
import { SketchSolverContext } from "./solver-context.js";
import { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";
import { SolvedPointRef } from "./refs.js";
import type { EntityKind } from "../../../sketch-solver/index.js";

export class SolvedPoint extends SolvedGeometryBase {

  constructor(private position: Point2D) {
    super();
  }

  get solverKind(): EntityKind {
    return 'point';
  }

  protected registerInto(ctx: SketchSolverContext): number {
    return ctx.addPoint(this, this.position.x, this.position.y);
  }

  pointValue(_role: SolvedPointRole): Point2D {
    const [x, y] = this.solverValues();
    return new Point2D(x, y);
  }

  private solverValues(): number[] {
    return this.requireContext().entityParams(this.entityId);
  }

  build(): void {
    const [x, y] = this.solvedParams();
    const plane = this.sketch.getPlane();
    const local = new Point2D(x, y);

    const vertex = Vertex.fromPoint(plane.localToWorld(local));
    this.addShape(vertex);

    this.setState('start', Vertex.fromPoint2D(local));
    this.setState('end', Vertex.fromPoint2D(local));
    this.setState('solved', { x, y });
  }

  override start(): SolvedPointRef {
    return this.pointRef('center');
  }

  override end(): SolvedPointRef {
    return this.pointRef('center');
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SolvedPoint(this.position);
    this.copySolvedStateTo(copy);
    return copy;
  }

  compareTo(other: SolvedPoint): boolean {
    if (!(other instanceof SolvedPoint)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.position.x === other.position.x
      && this.position.y === other.position.y
      && this.compareSolvedTo(other);
  }

  getType(): string {
    return 'point';
  }

  getUniqueType(): string {
    return 'solved-point';
  }

  serialize() {
    const solved = this.getState('solved') as { x: number; y: number } | undefined;
    return {
      entityId: this.entityId,
      x: solved?.x ?? this.position.x,
      y: solved?.y ?? this.position.y,
      // Statement-time argument values: the drag write-back drift-guards its
      // literal splices against these (P4).
      guess: { point: { x: this.position.x, y: this.position.y } },
    };
  }
}
