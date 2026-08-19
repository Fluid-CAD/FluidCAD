import { Point2D } from "../../../math/point.js";
import { Vertex } from "../../../common/vertex.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Edge } from "../../../common/edge.js";
import { Wire } from "../../../common/wire.js";
import { Geometry } from "../../../oc/geometry.js";
import { Plane } from "../../../math/plane.js";
import { Extrudable } from "../../../helpers/types.js";
import { GeometrySceneObject } from "../geometry.js";
import { SketchSolverContext } from "./solver-context.js";
import { SolvedGeometryBase, SolvedPointRole } from "./solved-base.js";
import { SolvedPointRef } from "./refs.js";
import type { EntityKind } from "../../../sketch-solver/index.js";

export class SolvedCircle extends SolvedGeometryBase implements Extrudable {

  constructor(private centerGuess: Point2D, private diameter: number) {
    super();
  }

  get solverKind(): EntityKind {
    return 'circle';
  }

  protected registerInto(ctx: SketchSolverContext): number {
    return ctx.addCircle(this, this.centerGuess.x, this.centerGuess.y, this.diameter / 2);
  }

  pointValue(role: SolvedPointRole): Point2D {
    if (role !== 'center') {
      throw new Error(`circle has no '${role}' point`);
    }
    const [cx, cy] = this.requireContext().entityParams(this.entityId);
    return new Point2D(cx, cy);
  }

  build(): void {
    const [cx, cy, r] = this.solvedParams();
    const plane = this.sketch.getPlane();
    const center = new Point2D(cx, cy);
    const worldCenter = plane.localToWorld(center);

    const circle = Geometry.makeCircle(worldCenter, r, plane.normal);
    const edge = Geometry.makeEdgeFromCircle(circle);
    edge.setRole('perimeter');
    this.addShape(edge);

    const centerVertex = Vertex.fromPoint(worldCenter);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);

    this.setState('solved', { center: { x: cx, y: cy }, diameter: r * 2 });
  }

  center(): SolvedPointRef {
    return this.pointRef('center');
  }

  isExtrudable(): boolean {
    return true;
  }

  getGeometries(): Edge[] {
    return this.getShapes() as Edge[];
  }

  getGeometriesWithOwner(): Map<Wire | Edge, GeometrySceneObject> {
    const geometries = new Map<Wire | Edge, GeometrySceneObject>();
    for (const shape of this.getShapes()) {
      if (shape instanceof Edge) {
        geometries.set(shape, this);
      }
    }
    return geometries;
  }

  getPlane(): Plane {
    return this.sketch.getPlane();
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SolvedCircle(this.centerGuess, this.diameter);
    this.copySolvedStateTo(copy);
    return copy;
  }

  compareTo(other: SolvedCircle): boolean {
    if (!(other instanceof SolvedCircle)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.centerGuess.x === other.centerGuess.x
      && this.centerGuess.y === other.centerGuess.y
      && this.diameter === other.diameter
      && this.compareSolvedTo(other);
  }

  getType(): string {
    return 'circle';
  }

  getUniqueType(): string {
    return 'solved-circle';
  }

  serialize() {
    const solved = this.getState('solved') as
      { center: { x: number; y: number }; diameter: number } | undefined;
    return {
      entityId: this.entityId,
      center: solved?.center ?? { x: this.centerGuess.x, y: this.centerGuess.y },
      diameter: solved?.diameter ?? this.diameter,
    };
  }
}
