import { SceneObject } from "../../common/scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";
import { IALine } from "../../core/interfaces.js";
import { findNearestRayIntersection } from "../../oc/ray-intersect.js";

export class AngledLine extends GeometrySceneObject implements IALine {

  private _centered: boolean = false;

  constructor(
    public angle: number,
    public lengthOrTarget: number | SceneObject,
    private targetPlane: PlaneObjectBase = null
  ) {
    super();
  }

  centered(value: boolean = true): this {
    this._centered = value;
    return this;
  }

  build() {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();

    let tangent = this.sketch?.getTangentAt(this) ?? new Point2D(1, 0);

    tangent = tangent.normalize();

    const angleRad = rad(this.angle);

    // 2D rotation of tangent by angle
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const dirX = cos * tangent.x - sin * tangent.y;
    const dirY = sin * tangent.x + cos * tangent.y;
    const direction = new Point2D(dirX, dirY);

    const currentPos = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    let startPoint: Point2D;
    let endPoint: Point2D;

    if (typeof this.lengthOrTarget === 'number') {
      const length = this.lengthOrTarget;
      startPoint = this._centered
        ? currentPos.translate(-direction.x * length / 2, -direction.y * length / 2)
        : currentPos;
      endPoint = startPoint.translate(direction.x * length, direction.y * length);
    } else {
      if (this._centered) {
        throw new Error('aLine: .centered() cannot be combined with a target geometry');
      }
      startPoint = currentPos;
      const hit = findNearestRayIntersection(plane, startPoint, direction, this.lengthOrTarget);
      if (!hit) {
        throw new Error("Line does not intersect target geometry");
      }
      endPoint = hit;
    }

    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));
    this.addShape(edge);

    // Tangent at end points from start to end (sign-aware when target is behind start)
    const endTangent = endPoint.subtract(startPoint);
    const endLen = Math.hypot(endTangent.x, endTangent.y);
    if (endLen > 1e-12) {
      this.setTangent(new Point2D(endTangent.x / endLen, endTangent.y / endLen));
    } else {
      this.setTangent(direction.normalize());
    }
    if (this.sketch) {
      this.setCurrentPosition(endPoint);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.targetPlane) {
      deps.push(this.targetPlane);
    }
    if (this.lengthOrTarget instanceof SceneObject) {
      deps.push(this.lengthOrTarget);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const lengthOrTarget = this.lengthOrTarget instanceof SceneObject
      ? (remap.get(this.lengthOrTarget) || this.lengthOrTarget)
      : this.lengthOrTarget;
    const copy = new AngledLine(this.angle, lengthOrTarget, targetPlane);
    copy.centered(this._centered);
    return copy;
  }

  compareTo(other: AngledLine): boolean {
    if (!(other instanceof AngledLine)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }
    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    if (typeof this.lengthOrTarget !== typeof other.lengthOrTarget) {
      return false;
    }
    if (this.lengthOrTarget instanceof SceneObject && other.lengthOrTarget instanceof SceneObject) {
      if (!this.lengthOrTarget.compareTo(other.lengthOrTarget)) {
        return false;
      }
    } else if (this.lengthOrTarget !== other.lengthOrTarget) {
      return false;
    }

    return this.angle === other.angle && this._centered === other._centered;
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'aline';
  }

  serialize() {
    return {
      angle: this.angle,
      length: typeof this.lengthOrTarget === 'number' ? this.lengthOrTarget : null,
      centered: this._centered
    }
  }
}
