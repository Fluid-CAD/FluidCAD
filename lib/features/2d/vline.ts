import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";
import { IVLine } from "../../core/interfaces.js";
import { SceneObject } from "../../common/scene-object.js";
import { findNearestRayIntersection } from "../../oc/ray-intersect.js";

export class VerticalLine extends GeometrySceneObject implements IVLine {

  private _centered: boolean = false;

  constructor(
    public distanceOrTarget: number | SceneObject,
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

    const currentPos = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    let startPoint: Point2D;
    let endPoint: Point2D;
    let signedLength: number;

    if (typeof this.distanceOrTarget === 'number') {
      const distance = this.distanceOrTarget;
      startPoint = this._centered
        ? currentPos.translate(0, -distance / 2)
        : currentPos;
      endPoint = startPoint.translate(0, distance);
      signedLength = distance;
    } else {
      if (this._centered) {
        throw new Error('vLine: .centered() cannot be combined with a target geometry');
      }
      startPoint = currentPos;
      endPoint = findNearestRayIntersection(plane, startPoint, new Point2D(0, 1), this.distanceOrTarget);
      signedLength = endPoint.y - startPoint.y;
    }

    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));
    this.addShape(edge);

    const sign = Math.sign(signedLength) || 1;
    this.setTangent(new Point2D(0, sign));
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
    if (this.distanceOrTarget instanceof SceneObject) {
      deps.push(this.distanceOrTarget);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const distanceOrTarget = this.distanceOrTarget instanceof SceneObject
      ? (remap.get(this.distanceOrTarget) || this.distanceOrTarget)
      : this.distanceOrTarget;
    const copy = new VerticalLine(distanceOrTarget, targetPlane);
    copy.centered(this._centered);
    return copy;
  }

  compareTo(other: VerticalLine): boolean {
    if (!(other instanceof VerticalLine)) {
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

    if (typeof this.distanceOrTarget !== typeof other.distanceOrTarget) {
      return false;
    }
    if (this.distanceOrTarget instanceof SceneObject && other.distanceOrTarget instanceof SceneObject) {
      if (!this.distanceOrTarget.compareTo(other.distanceOrTarget)) {
        return false;
      }
    } else if (this.distanceOrTarget !== other.distanceOrTarget) {
      return false;
    }

    return this._centered === other._centered;
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'vline';
  }

  serialize() {
    return {
      distance: typeof this.distanceOrTarget === 'number' ? this.distanceOrTarget : null,
      centered: this._centered
    }
  }
}
