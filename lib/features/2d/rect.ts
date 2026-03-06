import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { WireOps } from "../../oc/wire-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { LazySceneObject } from "../lazy-scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { Plane } from "../../math/plane.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class Rect extends ExtrudableGeometryBase {
  private _radius?: number | number[];
  private _center: boolean | 'horizontal' | 'vertical' = false;

  constructor(
    public width: number,
    public height: number,
    targetPlane: PlaneObjectBase = null,
    ) {
    super(targetPlane);
  }

  build(): void {
    const plane = this.targetPlane?.getPlane() || (this.getParent() as Sketch).getPlane();
    let start = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();
    console.log("Rect::build start:", start);
    let end = new Point2D(start.x + this.width, start.y + this.height);

    if (this._center === true) {
      end = start;
      start = start.translate(-this.width / 2, -this.height / 2);
    }
    else if (this._center === 'horizontal') {
      end = start;
      start = start.translate(-this.width / 2, 0);
    }
    else if (this._center === 'vertical') {
      end = start;
      start = start.translate(0, -this.height / 2);
    }

    let edges: Edge[] = [];
    if (this._radius) {
      edges = this.buildRoundedRect(start, plane);
    }
    else {
      edges = this.buildSimpleRect(start, plane);
    }

    let wire = WireOps.makeWireFromEdges(edges);

    this.addShape(wire);
    if (this.sketch) this.setCurrentPosition(end);

    if (this.targetPlane) this.targetPlane.removeShapes(this);
  }

  buildSimpleRect(start: Point2D, plane: Plane) {
    const bottomLeft = start;
    const topRight = new Point2D(bottomLeft.x + this.width, bottomLeft.y + this.height);
    const bottomRight = new Point2D(topRight.x, bottomLeft.y);
    const topLeft = new Point2D(bottomLeft.x, topRight.y);

    let segment1 = Geometry.makeSegment(plane.localToWorld(bottomLeft),
      plane.localToWorld(bottomRight));
    let segment2 = Geometry.makeSegment(plane.localToWorld(bottomRight),
      plane.localToWorld(topRight));
    let segment3 = Geometry.makeSegment(plane.localToWorld(topRight),
      plane.localToWorld(topLeft));
    let segment4 = Geometry.makeSegment(plane.localToWorld(topLeft),
      plane.localToWorld(bottomLeft));

    const result = [
      Geometry.makeEdge(segment1),
      Geometry.makeEdge(segment2),
      Geometry.makeEdge(segment3),
      Geometry.makeEdge(segment4),
    ];

    this.setState('bottomEdge', result[0]);
    this.setState('rightEdge', result[1]);
    this.setState('topEdge', result[2]);
    this.setState('leftEdge', result[3]);

    return result;
  }

  buildRoundedRect(start: Point2D, plane: Plane) {
    const radius = Array.isArray(this._radius) ? this._radius :
      [this._radius,
      this._radius || 0,
      this._radius || 0,
      this._radius || 0];

    const [bottomLeftRadius, bottomRightRadius, topRightRadius, topLeftRadius] = radius;

    const bottomLeft = start;

    const topRight = new Point2D(bottomLeft.x + this.width, bottomLeft.y + this.height);

    const bottomLeftArcCenter = new Point2D(bottomLeft.x + bottomLeftRadius, bottomLeft.y + bottomLeftRadius)
    const bottomRightArcCenter = new Point2D(topRight.x - bottomRightRadius, bottomLeft.y + bottomRightRadius);
    const topRightArcCenter = new Point2D(topRight.x - topRightRadius, topRight.y - topRightRadius);
    const topLeftArcCenter = new Point2D(bottomLeft.x + topLeftRadius, topRight.y - topLeftRadius);

    const bottomLineStart = new Point2D(bottomLeft.x + bottomLeftRadius, bottomLeft.y);
    const bottomLineEnd = new Point2D(topRight.x - bottomRightRadius, bottomLeft.y);

    const rightLineStart = new Point2D(topRight.x, bottomLeft.y + bottomRightRadius);
    const rightLineEnd = new Point2D(topRight.x, topRight.y - topRightRadius);

    const topLineStart = new Point2D(topRight.x - topRightRadius, topRight.y);
    const topLineEnd = new Point2D(bottomLeft.x + topLeftRadius, topRight.y);

    const leftLineStart = new Point2D(bottomLeft.x, topRight.y - topLeftRadius);
    const leftLineEnd = new Point2D(bottomLeft.x, bottomLeft.y + bottomLeftRadius);

    const localToWorld = plane.localToWorld.bind(plane);

    const bottomLineSegment = Geometry.makeSegment(
      localToWorld(bottomLineStart),
      localToWorld(bottomLineEnd)
    );

    const rightLineSegment = Geometry.makeSegment(
      localToWorld(rightLineStart),
      localToWorld(rightLineEnd)
    );

    const topLineSegment = Geometry.makeSegment(
      localToWorld(topLineStart),
      localToWorld(topLineEnd)
    );

    const leftLineSegment = Geometry.makeSegment(
      localToWorld(leftLineStart),
      localToWorld(leftLineEnd)
    );

    let bottomRightArcEdge: Edge | null = null;
    if (bottomRightRadius > 0) {
      const arc = Geometry.makeArc(
        localToWorld(bottomRightArcCenter),
        bottomRightRadius,
        plane.normal,
        localToWorld(bottomLineEnd),
        localToWorld(rightLineStart)
      );
      bottomRightArcEdge = Geometry.makeEdgeFromCurve(arc);
    }

    let topRightArcEdge: Edge | null = null;
    if (topRightRadius > 0) {
      const arc = Geometry.makeArc(
        localToWorld(topRightArcCenter),
        topRightRadius,
        plane.normal,
        localToWorld(rightLineEnd),
        localToWorld(topLineStart)
      );
      topRightArcEdge = Geometry.makeEdgeFromCurve(arc);
    }

    let topLeftArcEdge: Edge | null = null;
    if (topLeftRadius > 0) {
      const arc = Geometry.makeArc(
        localToWorld(topLeftArcCenter),
        topLeftRadius,
        plane.normal,
        localToWorld(topLineEnd),
        localToWorld(leftLineStart)
      );
      topLeftArcEdge = Geometry.makeEdgeFromCurve(arc);
    }

    let bottomLeftArcEdge: Edge | null = null;
    if (bottomLeftRadius > 0) {
      const arc = Geometry.makeArc(
        localToWorld(bottomLeftArcCenter),
        bottomLeftRadius,
        plane.normal,
        localToWorld(leftLineEnd),
        localToWorld(bottomLineStart)
      );
      bottomLeftArcEdge = Geometry.makeEdgeFromCurve(arc);
    }

    const bottomEdge = Geometry.makeEdge(bottomLineSegment);
    const rightEdge = Geometry.makeEdge(rightLineSegment);
    const topEdge = Geometry.makeEdge(topLineSegment);
    const leftEdge = Geometry.makeEdge(leftLineSegment);

    this.setState('bottomEdge', bottomEdge);
    this.setState('rightEdge', rightEdge);
    this.setState('topEdge', topEdge);
    this.setState('leftEdge', leftEdge);
    this.setState('bottomRightArcEdge', bottomRightArcEdge);
    this.setState('topRightArcEdge', topRightArcEdge);
    this.setState('topLeftArcEdge', topLeftArcEdge);
    this.setState('bottomLeftArcEdge', bottomLeftArcEdge);

    return [
      bottomEdge,
      bottomRightArcEdge,
      rightEdge,
      topRightArcEdge,
      topEdge,
      topLeftArcEdge,
      leftEdge,
      bottomLeftArcEdge,
    ].filter(e => e !== null) as Edge[];
  }

  getType(): string {
    return 'rect';
  }

  override clone(): SceneObject[] {
    const targetPlane = this.targetPlane ? this.targetPlane.clone()[0] as PlaneObjectBase : null;
    const rect = new Rect(this.width, this.height, targetPlane);
    if (this._radius) {
      rect.radius(...(Array.isArray(this._radius) ? this._radius : [this._radius]));
    }

    rect.center(this._center);

    return [rect];
  }

  override compareTo(other: Rect): boolean {
    if (!(other instanceof Rect)) {
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

    if (this.width !== other.width || this.height !== other.height || this._center !== other._center) {
      return false;
    }

    const thisRadius = Array.isArray(this._radius) ? this._radius : [this._radius || 0,
    this._radius || 0,
    this._radius || 0,
    this._radius || 0];

    const otherRadius = Array.isArray(other._radius) ? other._radius : [other._radius || 0,
    other._radius || 0,
    other._radius || 0,
    other._radius || 0];

    return thisRadius.every((r, i) => r === otherRadius[i]);
  }

  topEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('top-edge'), () => [this.getState('topEdge')]);
  }

  bottomEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('bottom-edge'), () => [this.getState('bottomEdge')]);
  }

  leftEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('left-edge'), () => [this.getState('leftEdge')]);
  }

  rightEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('right-edge'), () => [this.getState('rightEdge')]);
  }

  topLeftArcEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('top-left-arc'), () => [this.getState('topLeftArcEdge')]);
  }

  topRightArcEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('top-right-arc'), () => [this.getState('topRightArcEdge')]);
  }

  bottomLeftArcEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('bottom-left-arc'), () => [this.getState('bottomLeftArcEdge')]);
  }

  bottomRightArcEdge(): LazySceneObject {
    return new LazySceneObject(this.generateUniqueName('bottom-right-arc'), () => [this.getState('bottomRightArcEdge')]);
  }

  topLeft(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('top-left-vertex'), () => {
      const edge = this.getState('topEdge') as Edge;
      if (!edge) {
        return [];
      }
      return [edge.getLastVertex()];
    });
  }

  topRight(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('top-right-vertex'), () => {
      const edge = this.getState('topEdge') as Edge;
      if (!edge) {
        return [];
      }
      return [edge.getFirstVertex()];
    });
  }

  bottomLeft(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('bottom-left-vertex'), () => {
      const edge = this.getState('bottomEdge') as Edge;
      if (!edge) {
        return [];
      }
      return [edge.getFirstVertex()];
    });
  }

  bottomRight(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('bottom-right-vertex'), () => {
      const edge = this.getState('bottomEdge') as Edge;
      if (!edge) {
        return [];
      }
      return [edge.getLastVertex()];
    });
  }

  radius(...r: number[]): this {
    if (r.length === 1) {
      this._radius = r[0]
    }
    else {
      this._radius = r;
    }

    this._radius = r;
    return this;
  }

  center(value: boolean | 'horizontal' | 'vertical' = true): this {
    this._center = value;
    return this;
  }

  serialize() {
    return {
      width: this.width,
      height: this.height,
      radius: this._radius,
      center: this._center
    };
  }
}
