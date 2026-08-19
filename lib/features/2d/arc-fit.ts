import { Point2D } from "../../math/point.js";
import { Plane } from "../../math/plane.js";
import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";

export type FittedArc = {
  edge: Edge;
  /** Center of the circle actually fitted through both endpoints. */
  actualCenter: Point2D;
  /** Unit tangent at the authored end point, in plane-local coords. */
  endTangent: Point2D;
};

/**
 * Arc through both authored endpoints, sweeping around centerPt in the
 * requested direction. The authored center only picks the sweep side and
 * nominal radius: the actual circle is fitted through start/mid/end, so an
 * authored endpoint slightly off the center's circle (rounded coordinates)
 * still lands exactly on the built edge — downstream chaining and closing
 * rely on the endpoints being exact.
 */
export function fitArcThroughEndpoints(
  plane: Plane,
  startPt: Point2D,
  endPt: Point2D,
  centerPt: Point2D,
  clockwise: boolean,
): FittedArc {
  const aStart = Math.atan2(startPt.y - centerPt.y, startPt.x - centerPt.x);
  const aEnd = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);
  let sweep = clockwise ? aStart - aEnd : aEnd - aStart;
  if (sweep <= 0) {
    sweep += 2 * Math.PI;
  }
  const midAngle = clockwise ? aStart - sweep / 2 : aStart + sweep / 2;
  const rStart = Math.sqrt((startPt.x - centerPt.x) ** 2 + (startPt.y - centerPt.y) ** 2);
  const rEnd = Math.sqrt((endPt.x - centerPt.x) ** 2 + (endPt.y - centerPt.y) ** 2);
  const rMid = (rStart + rEnd) / 2;
  const midPt = new Point2D(
    centerPt.x + rMid * Math.cos(midAngle),
    centerPt.y + rMid * Math.sin(midAngle),
  );

  const actualCenter = circumcenter(startPt, midPt, endPt);

  const endAngle = Math.atan2(endPt.y - actualCenter.y, endPt.x - actualCenter.x);

  const start = plane.localToWorld(startPt);
  const end = plane.localToWorld(endPt);
  const mid = plane.localToWorld(midPt);

  const arc = Geometry.makeArcThreePoints(start, mid, end);
  const edge = Geometry.makeEdgeFromCurve(arc);

  const sign = clockwise ? -1 : 1;
  const endTangent = new Point2D(sign * (-Math.sin(endAngle)), sign * Math.cos(endAngle));

  return { edge, actualCenter, endTangent };
}

function circumcenter(a: Point2D, b: Point2D, c: Point2D): Point2D {
  const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  return new Point2D(
    (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / D,
    (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / D,
  );
}
