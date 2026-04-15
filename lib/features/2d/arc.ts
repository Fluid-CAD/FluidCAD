import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D, Point2DLike } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { IArcPoints, IArcAngles } from "../../core/interfaces.js";

export class Arc extends GeometrySceneObject implements IArcPoints, IArcAngles {
  // Two-point mode state (set by factory)
  private _startPoint: LazyVertex | null = null;
  private _endPoint: LazyVertex | null = null;

  // Angle mode state (set by factory)
  private _arcRadius: number = 0;
  private _startAngle: number = 0;
  private _endAngle: number = 180;

  // Chainable state
  private _bulgeRadius: number = 0;
  private _centerPoint: LazyVertex | null = null;
  private _centered: boolean = false;

  private _targetPlane: PlaneObjectBase | null;

  constructor(targetPlane: PlaneObjectBase | null = null) {
    super();
    this._targetPlane = targetPlane;
  }

  static toPoint(endPoint: LazyVertex, targetPlane: PlaneObjectBase | null = null): Arc {
    const arc = new Arc(targetPlane);
    arc._endPoint = endPoint;
    return arc;
  }

  static twoPoints(startPoint: LazyVertex, endPoint: LazyVertex, targetPlane: PlaneObjectBase | null = null): Arc {
    const arc = new Arc(targetPlane);
    arc._startPoint = startPoint;
    arc._endPoint = endPoint;
    return arc;
  }

  static fromAngles(arcRadius: number, startAngle: number, endAngle: number, targetPlane: PlaneObjectBase | null = null): Arc {
    const arc = new Arc(targetPlane);
    arc._arcRadius = arcRadius;
    arc._startAngle = startAngle;
    arc._endAngle = endAngle;
    return arc;
  }

  // Chainable methods (IArc)

  radius(value: number): this {
    this._bulgeRadius = value;
    return this;
  }

  center(value: Point2DLike): this {
    this._centerPoint = normalizePoint2D(value);
    return this;
  }

  centered(): this {
    this._centered = true;
    return this;
  }

  build(): void {
    if (this._startPoint && this._endPoint) {
      // Two explicit points: default center = current position
      if (this._bulgeRadius !== 0) {
        this.buildTwoPointsBulge();
      } else {
        this.buildTwoPointsCenter();
      }
    } else if (this._endPoint) {
      // From current position to endpoint
      if (this._centerPoint) {
        this.buildWithCenter();
      } else {
        this.buildToPoint();
      }
    } else {
      this.buildFromAngles();
    }
  }

  private buildTwoPointsCenter(): void {
    const plane = this._targetPlane?.getPlane() || this.sketch.getPlane();

    const startPt = this._startPoint.asPoint2D();
    const endPt = this._endPoint.asPoint2D();
    const centerPt = this._centerPoint
      ? this._centerPoint.asPoint2D()
      : this.getCurrentPosition();

    const dx = startPt.x - centerPt.x;
    const dy = startPt.y - centerPt.y;
    const radius = Math.sqrt(dx * dx + dy * dy);

    const endAngle = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);

    const center = plane.localToWorld(centerPt);
    const start = plane.localToWorld(startPt);
    const end = plane.localToWorld(endPt);

    const arc = Geometry.makeArc(center, radius, plane.normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const tx = -Math.sin(endAngle);
    const ty = Math.cos(endAngle);
    this.setTangent(new Point2D(tx, ty));

    this.setState('start', Vertex.fromPoint2D(startPt));
    this.setState('end', Vertex.fromPoint2D(endPt));
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(endPt);
    }

    if (this._targetPlane) {
      this._targetPlane.removeShapes(this);
    }
  }

  private buildTwoPointsBulge(): void {
    const plane = this._targetPlane?.getPlane() || this.sketch.getPlane();

    const startPoint = this._startPoint.asPoint2D();
    const targetPoint = this._endPoint.asPoint2D();

    const dx = targetPoint.x - startPoint.x;
    const dy = targetPoint.y - startPoint.y;
    const chordLen = Math.sqrt(dx * dx + dy * dy);

    let r = this._bulgeRadius;
    const cw = r < 0;
    r = Math.abs(r);

    if (r < chordLen / 2) {
      r = chordLen / 2;
    }

    const mx = (startPoint.x + targetPoint.x) / 2;
    const my = (startPoint.y + targetPoint.y) / 2;

    const px = -dy / chordLen;
    const py = dx / chordLen;

    const d = Math.sqrt(r * r - (chordLen / 2) * (chordLen / 2));

    const sign = cw ? -1 : 1;
    const centerPoint = new Point2D(mx + sign * d * px, my + sign * d * py);

    const endAngle = Math.atan2(targetPoint.y - centerPoint.y, targetPoint.x - centerPoint.x);

    const normal = cw ? plane.normal.negate() : plane.normal;

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(targetPoint);

    const arc = Geometry.makeArc(center, r, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const signT = cw ? -1 : 1;
    const endTx = signT * (-Math.sin(endAngle));
    const endTy = signT * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(targetPoint));
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(targetPoint);
    }

    if (this._targetPlane) {
      this._targetPlane.removeShapes(this);
    }
  }

  private buildToPoint(): void {
    const plane = this._targetPlane?.getPlane() || this.sketch.getPlane();
    const targetPoint = this._endPoint.asPoint2D();

    const startPoint = this._targetPlane
      ? plane.worldToLocal(this._targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const dx = targetPoint.x - startPoint.x;
    const dy = targetPoint.y - startPoint.y;
    const chordLen = Math.sqrt(dx * dx + dy * dy);

    let r = this._bulgeRadius || (chordLen / 2);
    const cw = r < 0;
    r = Math.abs(r);

    if (r < chordLen / 2) {
      r = chordLen / 2;
    }

    const mx = (startPoint.x + targetPoint.x) / 2;
    const my = (startPoint.y + targetPoint.y) / 2;

    const px = -dy / chordLen;
    const py = dx / chordLen;

    const d = Math.sqrt(r * r - (chordLen / 2) * (chordLen / 2));

    const sign = cw ? -1 : 1;
    const centerPoint = new Point2D(mx + sign * d * px, my + sign * d * py);

    const startAngle = Math.atan2(startPoint.y - centerPoint.y, startPoint.x - centerPoint.x);
    const endAngle = Math.atan2(targetPoint.y - centerPoint.y, targetPoint.x - centerPoint.x);

    const normal = cw ? plane.normal.negate() : plane.normal;

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(targetPoint);

    const arc = Geometry.makeArc(center, r, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const signT = cw ? -1 : 1;
    const endTx = signT * (-Math.sin(endAngle));
    const endTy = signT * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(targetPoint));
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(targetPoint);
    }

    if (this._targetPlane) {
      this._targetPlane.removeShapes(this);
    }
  }

  private buildWithCenter(): void {
    const plane = this._targetPlane?.getPlane() || this.sketch.getPlane();

    const startPt = this._targetPlane
      ? plane.worldToLocal(this._targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const endPt = this._endPoint.asPoint2D();
    const centerPt = this._centerPoint.asPoint2D();

    const dx = startPt.x - centerPt.x;
    const dy = startPt.y - centerPt.y;
    const radius = Math.sqrt(dx * dx + dy * dy);

    const endAngle = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);

    const center = plane.localToWorld(centerPt);
    const start = plane.localToWorld(startPt);
    const end = plane.localToWorld(endPt);

    const arc = Geometry.makeArc(center, radius, plane.normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const tx = -Math.sin(endAngle);
    const ty = Math.cos(endAngle);
    this.setTangent(new Point2D(tx, ty));

    this.setState('start', Vertex.fromPoint2D(startPt));
    this.setState('end', Vertex.fromPoint2D(endPt));
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(endPt);
    }

    if (this._targetPlane) {
      this._targetPlane.removeShapes(this);
    }
  }

  private buildFromAngles(): void {
    const plane = this._targetPlane?.getPlane() || this.sketch.getPlane();
    const radius = this._arcRadius;

    const centerPoint = this._targetPlane
      ? plane.worldToLocal(this._targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const cw = this._endAngle < 0;
    const absStartAngle = Math.abs(this._startAngle);
    const absEndAngle = Math.abs(this._endAngle);

    let startAngleRad: number;
    let endAngleRad: number;

    if (this._centered) {
      const halfSweep = rad(absEndAngle) / 2;
      const midAngle = rad(absStartAngle);
      startAngleRad = midAngle - halfSweep;
      endAngleRad = midAngle + halfSweep;
    } else {
      startAngleRad = rad(absStartAngle);
      endAngleRad = rad(absEndAngle);
    }

    const normal = cw ? plane.normal.negate() : plane.normal;

    const startPoint = Geometry.getPointOnCircle(centerPoint, radius, startAngleRad);
    const endPoint = Geometry.getPointOnCircle(centerPoint, radius, endAngleRad);

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    const arc = Geometry.makeArc(center, radius, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));

    const sign = cw ? -1 : 1;
    const tx = sign * (-Math.sin(endAngleRad));
    const ty = sign * Math.cos(endAngleRad);

    this.setTangent(new Point2D(tx, ty));

    this.addShape(edge);

    if (this._targetPlane) {
      this._targetPlane.removeShapes(this);
    }
  }

  getType(): string {
    return 'arc';
  }

  compareTo(other: Arc): boolean {
    if (!(other instanceof Arc)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this._targetPlane?.constructor !== other._targetPlane?.constructor) {
      return false;
    }
    if (this._targetPlane && other._targetPlane && !this._targetPlane.compareTo(other._targetPlane)) {
      return false;
    }

    if (this._endPoint && other._endPoint) {
      if (!this._endPoint.compareTo(other._endPoint)) {
        return false;
      }
      if (this._startPoint && other._startPoint) {
        if (!this._startPoint.compareTo(other._startPoint)) {
          return false;
        }
      } else if (this._startPoint !== other._startPoint) {
        return false;
      }
      if (this._centerPoint && other._centerPoint) {
        return this._centerPoint.compareTo(other._centerPoint);
      }
      return this._bulgeRadius === other._bulgeRadius;
    }

    if (!this._endPoint && !other._endPoint) {
      return this._arcRadius === other._arcRadius &&
        this._startAngle === other._startAngle &&
        this._endAngle === other._endAngle &&
        this._centered === other._centered;
    }

    return false;
  }

  serialize() {
    if (this._endPoint) {
      const base: Record<string, unknown> = {
        endPoint: this._endPoint.serialize(),
      };
      if (this._startPoint) {
        base.startPoint = this._startPoint.serialize();
      }
      if (this._centerPoint) {
        base.center = this._centerPoint.serialize();
      }
      if (this._bulgeRadius !== 0) {
        base.radius = this._bulgeRadius;
      }
      return base;
    }
    return {
      radius: this._arcRadius,
      startAngle: this._startAngle,
      endAngle: this._endAngle,
      centered: this._centered
    };
  }
}
