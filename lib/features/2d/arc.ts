import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { type Point, Point2D, Point2DLike } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { IArcPoints, IArcRadius, IArcCenter, IArcAngles } from "../../core/interfaces.js";
import { SceneObject } from "../../common/scene-object.js";

export class Arc extends GeometrySceneObject implements IArcPoints, IArcRadius, IArcCenter, IArcAngles {
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
  private _clockwise: boolean = false;
  private _major: boolean = false;

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

  private static circumcenter(a: Point2D, b: Point2D, c: Point2D): Point2D {
    const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const aa = a.x * a.x + a.y * a.y;
    const bb = b.x * b.x + b.y * b.y;
    const cc = c.x * c.x + c.y * c.y;
    return new Point2D(
      (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / D,
      (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / D,
    );
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

  cw(): this {
    this._clockwise = true;
    return this;
  }

  major(): this {
    this._major = true;
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
      : new Point2D((startPt.x + endPt.x) / 2, (startPt.y + endPt.y) / 2);

    const dx = startPt.x - centerPt.x;
    const dy = startPt.y - centerPt.y;
    const radius = Math.sqrt(dx * dx + dy * dy);

    const endAngle = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);

    const normal = this._clockwise ? plane.normal.negate() : plane.normal;

    const center = plane.localToWorld(centerPt);
    const start = plane.localToWorld(startPt);
    const end = plane.localToWorld(endPt);

    const arc = Geometry.makeArc(center, radius, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const sign = this._clockwise ? -1 : 1;
    const tx = sign * (-Math.sin(endAngle));
    const ty = sign * Math.cos(endAngle);
    this.setTangent(new Point2D(tx, ty));

    this.setState('start', Vertex.fromPoint2D(startPt));
    this.setState('end', Vertex.fromPoint2D(endPt));
    const centerVertex = Vertex.fromPoint2D(centerPt);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
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

    const arc = this._major
      ? this.makeMajorArc(startPoint, targetPoint, centerPoint, cw, plane)
      : Geometry.makeArc(center, r, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const signT = (cw ? -1 : 1) * (this._major ? -1 : 1);
    const endTx = signT * (-Math.sin(endAngle));
    const endTy = signT * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(targetPoint));
    const centerVertex = Vertex.fromPoint2D(centerPoint);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
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

    const endAngle = Math.atan2(targetPoint.y - centerPoint.y, targetPoint.x - centerPoint.x);

    const normal = cw ? plane.normal.negate() : plane.normal;

    const center = plane.localToWorld(centerPoint);
    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(targetPoint);

    const arc = this._major
      ? this.makeMajorArc(startPoint, targetPoint, centerPoint, cw, plane)
      : Geometry.makeArc(center, r, normal, start, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const signT = (cw ? -1 : 1) * (this._major ? -1 : 1);
    const endTx = signT * (-Math.sin(endAngle));
    const endTy = signT * Math.cos(endAngle);

    this.setTangent(new Point2D(endTx, endTy));
    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(targetPoint));
    const centerVertex = Vertex.fromPoint2D(centerPoint);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
    this.addShape(edge);

    if (this.sketch) {
      this.setCurrentPosition(targetPoint);
    }

    if (this._targetPlane) {
      this._targetPlane.removeShapes(this);
    }
  }

  private makeMajorArc(
    startPoint2D: Point2D, endPoint2D: Point2D, centerPoint2D: Point2D,
    cw: boolean, plane: { localToWorld(p: Point2D): Point },
  ) {
    const startAngleRad = Math.atan2(startPoint2D.y - centerPoint2D.y, startPoint2D.x - centerPoint2D.x);
    const endAngleRad = Math.atan2(endPoint2D.y - centerPoint2D.y, endPoint2D.x - centerPoint2D.x);
    let minorSweep = cw ? startAngleRad - endAngleRad : endAngleRad - startAngleRad;
    if (minorSweep <= 0) { minorSweep += 2 * Math.PI; }
    const midAngle = cw
      ? startAngleRad + (2 * Math.PI - minorSweep) / 2
      : startAngleRad - (2 * Math.PI - minorSweep) / 2;
    const r = Math.sqrt(
      (startPoint2D.x - centerPoint2D.x) ** 2 +
      (startPoint2D.y - centerPoint2D.y) ** 2,
    );
    const midPoint2D = new Point2D(
      centerPoint2D.x + r * Math.cos(midAngle),
      centerPoint2D.y + r * Math.sin(midAngle),
    );
    const start = plane.localToWorld(startPoint2D);
    const mid = plane.localToWorld(midPoint2D);
    const end = plane.localToWorld(endPoint2D);
    return Geometry.makeArcThreePoints(start, mid, end);
  }

  private buildWithCenter(): void {
    const plane = this._targetPlane?.getPlane() || this.sketch.getPlane();

    const startPt = this._targetPlane
      ? plane.worldToLocal(this._targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const endPt = this._endPoint.asPoint2D();
    const centerPt = this._centerPoint.asPoint2D();

    const aStart = Math.atan2(startPt.y - centerPt.y, startPt.x - centerPt.x);
    const aEnd = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);
    let sweep = this._clockwise ? aStart - aEnd : aEnd - aStart;
    if (sweep <= 0) {
      sweep += 2 * Math.PI;
    }
    const midAngle = this._clockwise ? aStart - sweep / 2 : aStart + sweep / 2;
    const rStart = Math.sqrt((startPt.x - centerPt.x) ** 2 + (startPt.y - centerPt.y) ** 2);
    const rEnd = Math.sqrt((endPt.x - centerPt.x) ** 2 + (endPt.y - centerPt.y) ** 2);
    const rMid = (rStart + rEnd) / 2;
    const midPt = new Point2D(
      centerPt.x + rMid * Math.cos(midAngle),
      centerPt.y + rMid * Math.sin(midAngle),
    );

    const actualCenter = Arc.circumcenter(startPt, midPt, endPt);

    const endAngle = Math.atan2(endPt.y - actualCenter.y, endPt.x - actualCenter.x);

    const start = plane.localToWorld(startPt);
    const end = plane.localToWorld(endPt);
    const mid = plane.localToWorld(midPt);

    const arc = Geometry.makeArcThreePoints(start, mid, end);
    const edge = Geometry.makeEdgeFromCurve(arc);

    const sign = this._clockwise ? -1 : 1;
    const tx = sign * (-Math.sin(endAngle));
    const ty = sign * Math.cos(endAngle);
    this.setTangent(new Point2D(tx, ty));

    this.setState('start', Vertex.fromPoint2D(startPt));
    this.setState('end', Vertex.fromPoint2D(endPt));
    const centerVertex = Vertex.fromPoint2D(actualCenter);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
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

    // Angles are measured relative to the current tangent (defaults to +X).
    const tangent = (this._targetPlane ? null : this.sketch?.getTangentAt(this))
      ?? new Point2D(1, 0);
    const tangentAngle = Math.atan2(tangent.y, tangent.x);

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

    startAngleRad += tangentAngle;
    endAngleRad += tangentAngle;

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
    const centerVertex = Vertex.fromPoint2D(centerPoint);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);

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

  override getDependencies(): SceneObject[] {
    return this._targetPlane ? [this._targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this._targetPlane
      ? (remap.get(this._targetPlane) as PlaneObjectBase || this._targetPlane)
      : null;

    let copy: Arc;
    if (this._startPoint && this._endPoint) {
      copy = Arc.twoPoints(this._startPoint, this._endPoint, targetPlane);
    } else if (this._endPoint) {
      copy = Arc.toPoint(this._endPoint, targetPlane);
    } else {
      copy = Arc.fromAngles(this._arcRadius, this._startAngle, this._endAngle, targetPlane);
    }

    copy._bulgeRadius = this._bulgeRadius;
    copy._centerPoint = this._centerPoint;
    copy._centered = this._centered;
    copy._clockwise = this._clockwise;
    copy._major = this._major;

    return copy;
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

    if (this._clockwise !== other._clockwise) {
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
      return this._bulgeRadius === other._bulgeRadius && this._major === other._major;
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
      if (this._clockwise) {
        base.clockwise = true;
      }
      if (this._major) {
        base.major = true;
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
