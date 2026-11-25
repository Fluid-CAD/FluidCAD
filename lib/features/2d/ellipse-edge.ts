import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Point, Point2D } from "../../math/point.js";
import type { Vector3d } from "../../math/vector3d.js";
import type { EllipseArcSpan, EllipseFrame } from "../../sketch-solver/index.js";

const HALF_PI = Math.PI / 2;

/**
 * The ellipse in the kernel's terms. OCCT wants the major radius first and
 * measures its parameter from the major axis, so when RY is the longer
 * semi-radius the RY axis carries the major and the kernel's parameter
 * runs a quarter turn behind the sketch's (see `toKernelParam`).
 */
type KernelEllipse = {
  center: Point;
  major: number;
  minor: number;
  majorDir: Vector3d;
  rxIsMajor: boolean;
};

function kernelEllipse(plane: Plane, e: EllipseFrame): KernelEllipse {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  // The ellipse's own axes in world space: u carries RX, v carries RY.
  const u = plane.xDirection.multiply(c).add(plane.yDirection.multiply(s));
  const v = plane.xDirection.multiply(-s).add(plane.yDirection.multiply(c));
  const rxIsMajor = e.rx >= e.ry;
  return {
    center: plane.localToWorld(new Point2D(e.cx, e.cy)),
    major: rxIsMajor ? e.rx : e.ry,
    minor: rxIsMajor ? e.ry : e.rx,
    majorDir: rxIsMajor ? u : v,
    rxIsMajor,
  };
}

/** The whole ellipse as one closed edge on the sketch plane. */
export function buildEllipseEdge(plane: Plane, e: EllipseFrame): Edge {
  const k = kernelEllipse(plane, e);
  return Geometry.makeEllipseEdge(k.center, k.major, k.minor, plane.normal, k.majorDir);
}

/**
 * The elliptical arc as one edge on the sketch plane, running from the
 * span's start to its end. A clockwise span is built about the reversed
 * normal, where it is the counter-clockwise one, so the edge always runs
 * start to end along its own parameter and chains like any other edge.
 */
export function buildEllipseArcEdge(plane: Plane, span: EllipseArcSpan): Edge {
  const k = kernelEllipse(plane, span);
  // The sketch parameter measured from the major axis.
  const fromMajor = k.rxIsMajor ? span.startParam : span.startParam - HALF_PI;
  const clockwise = span.sweep < 0;
  const from = clockwise ? -fromMajor : fromMajor;
  return Geometry.makeEllipseArcEdge(
    k.center,
    k.major,
    k.minor,
    clockwise ? plane.normal.negate() : plane.normal,
    k.majorDir,
    from,
    from + Math.abs(span.sweep),
  );
}
