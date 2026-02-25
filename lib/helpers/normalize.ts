import { AxisLike } from "../math/axis.js";
import { CoordinateSystem } from "../math/coordinate-system.js";
import { Plane, PlaneLike } from "../math/plane.js";
import { Point, Point2D, Point2DLike, PointLike } from "../math/point.js";
import { Vector3d, Vector3dLike } from "../math/vector3d.js";

import { Face, Vertex } from "../common/shapes.js";
import { LazyVertex } from "../features/lazy-vertex.js";

export function normalizePoint(p: PointLike): LazyVertex {
  if (p instanceof LazyVertex) {
    return p;
  }
  let point: Point;
  if (p instanceof Point) {
    point = p;
  }

  if (Array.isArray(p)) {
    point = new Point(p[0], p[1], p[2]);
  } else if (typeof p === 'object' && 'x' in p && 'y' in p && 'z' in p) {
    point = new Point(p.x, p.y, p.z);
  }

  if (!point) {
    throw new Error("Failed to normalize point");
  }

  return LazyVertex.fromVertex(Vertex.fromPoint(point));
}

export function normalizePoint2DSafe(p: Point2DLike): LazyVertex {
  try {
    return normalizePoint2D(p);
  } catch (e) {
    console.error("Failed to normalize point2D:", e);
    return null;
  }
}

export function normalizePoint2D(p: Point2DLike): LazyVertex {
  let point2D: Point2D;
  if (p instanceof LazyVertex) {
    return p;
  }
  else if (p instanceof Point2D) {
    point2D = p;
  }
  else if (Array.isArray(p)) {
    point2D = new Point2D(p[0], p[1]);
  } else if (typeof p === 'object' && 'x' in p && 'y' in p) {
    point2D = new Point2D(p.x, p.y);
  } else {
    throw new Error("Invalid point2D format");
  }

  return new LazyVertex(`point2D-${point2D.x}-${point2D.y}`, () => [Vertex.fromPoint2D(point2D)]);
}

export function normalizeVector(v: Vector3dLike): Vector3d {
  if (v instanceof Vector3d) {
    return v;
  }

  if (Array.isArray(v)) {
    return new Vector3d(v[0], v[1], v[2]);
  } else if (typeof v === 'object' && 'x' in v && 'y' in v && 'z' in v) {
    return new Vector3d(v.x, v.y, v.z);
  } else {
    throw new Error("Invalid vector format");
  }
}

export function normalizePlane(arg: PlaneLike): Plane {
  if (typeof (arg) === 'string') {
    const world = CoordinateSystem.World();
    if (arg === 'xy' || arg === 'top') {
      return world.getXYPlane();
    }
    else if (arg === '-xy' || arg === 'bottom') {
      return world.getXYPlane().reverse()
    }
    else if (arg === 'xz' || arg === 'front') {
      return world.getXZPlane();
    }
    else if (arg === '-xz' || arg === 'back') {
      return world.getXZPlane().reverse()
    }
    else if (arg === 'yz' || arg === 'right') {
      return world.getYZPlane();
    }
    else if (arg === '-yz' || arg === 'left') {
      return world.getYZPlane().reverse()
    }
  }
  else if (arg instanceof Plane) {
    return arg;
  }

  throw new Error("Invalid plane format");
}

export function normalizeAxisSafe(a: AxisLike) {
  try {
    return normalizeAxis(a);
  } catch (e) {
    console.error("Failed to normalize axis:", e);
    return null;
  }
}

export function normalizeAxis(a: AxisLike) {
  const world = CoordinateSystem.World();
  if (typeof a === 'string') {
    if (a === 'x') {
      return world.xAxis;
    } else if (a === 'y') {
      return world.yAxis;
    } else if (a === 'z') {
      return world.mainAxis;
    }
  }

  throw new Error("Invalid axis format");
}
