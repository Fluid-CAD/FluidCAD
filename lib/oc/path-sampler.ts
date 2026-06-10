import type { BRepAdaptor_CompCurve, TopoDS_Wire } from "fluidcad-ocjs";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Wire } from "../common/wire.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";

export interface PathFrame {
  point: Point;
  /** Unit tangent in the direction of increasing arc length. */
  tangent: Vector3d;
}

/**
 * Arc-length parameterization of a wire. Wraps `BRepAdaptor_CompCurve` +
 * `GCPnts_AbscissaPoint` so callers can evaluate a point and unit tangent at a
 * distance measured along the path, independent of how the underlying curves
 * are parameterized (exact on Béziers/B-splines, not just lines and arcs).
 *
 * Out-of-range distances wrap around on a closed wire and extrapolate
 * linearly along the end tangents on an open one.
 */
export class PathSampler {
  private adaptor: BRepAdaptor_CompCurve;
  private firstParam: number;
  readonly length: number;
  readonly closed: boolean;

  constructor(wire: Wire) {
    const oc = getOC();
    this.adaptor = new oc.BRepAdaptor_CompCurve(wire.getShape() as TopoDS_Wire, false);
    this.firstParam = this.adaptor.FirstParameter();
    this.length = oc.GCPnts_AbscissaPoint.Length(this.adaptor);
    this.closed = this.adaptor.IsClosed();
  }

  evalAt(s: number): PathFrame {
    if (this.closed) {
      s = ((s % this.length) + this.length) % this.length;
    } else if (s < 0) {
      const start = this.evalOn(0);
      return { point: start.point.add(start.tangent.multiply(s)), tangent: start.tangent };
    } else if (s > this.length) {
      const end = this.evalOn(this.length);
      return { point: end.point.add(end.tangent.multiply(s - this.length)), tangent: end.tangent };
    }
    return this.evalOn(s);
  }

  /** `count + 1` points evenly spaced by arc length, including both ends. */
  sample(count: number): Point[] {
    const points: Point[] = [];
    for (let i = 0; i <= count; i++) {
      points.push(this.evalOn((this.length * i) / count).point);
    }
    return points;
  }

  private evalOn(s: number): PathFrame {
    const oc = getOC();
    const abscissa = new oc.GCPnts_AbscissaPoint(this.adaptor, s, this.firstParam);
    if (!abscissa.IsDone()) {
      abscissa.delete();
      throw new Error(`Failed to locate arc-length ${s} on path (length ${this.length}).`);
    }
    const u = abscissa.Parameter();
    abscissa.delete();

    const res = this.adaptor.EvalD1(u);
    const point = Convert.toPoint(res.Point, true);
    const tangent = Convert.toVector3d(res.D1, true).normalize();
    return { point, tangent };
  }

  dispose(): void {
    this.adaptor.delete();
  }
}
