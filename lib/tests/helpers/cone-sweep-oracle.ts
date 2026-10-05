import type { ResolvedHelixGeometry } from "../../math/helix-geometry.js";
import type { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

/** Analytic constant-binormal law; no sampled/built OCCT surfaces are used. */
function station(g: ResolvedHelixGeometry, t: number) {
  const radialRate = (g.endRadius - g.startRadius) / g.parameterEnd;
  const axialRate = (g.zEnd - g.zStart) / g.parameterEnd;
  const r = g.startRadius + radialRate * t;
  const angle = g.winding * t;
  const { origin, mainDirection: z, xDirection: x, yDirection: y } = g.frame;
  const center = origin.add(z.multiply(g.zStart + axialRate * t))
    .add(x.multiply(r * Math.cos(angle))).add(y.multiply(r * Math.sin(angle)));
  const derivative = z.multiply(axialRate)
    .add(x.multiply(radialRate * Math.cos(angle) - g.winding * r * Math.sin(angle)))
    .add(y.multiply(radialRate * Math.sin(angle) + g.winding * r * Math.cos(angle)));
  // OCCT ConstantBiNormal projects the tangent into the plane normal to the
  // fixed axis. Its azimuth includes the changing radial-derivative angle.
  const rotation = angle + Math.atan2(g.winding * r, radialRate) - Math.atan2(g.winding * g.startRadius, radialRate);
  const rate = g.winding * (1 + radialRate ** 2 / (radialRate ** 2 + r ** 2));
  const rotate = (v: Vector3d) => {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    return v.multiply(c).add(z.cross(v).multiply(s)).add(z.multiply(z.dot(v) * (1 - c)));
  };
  return { center, derivative, rotate, rate };
}

export function coneSectionPoint(g: ResolvedHelixGeometry, plane: Plane, fraction: number, u: number, v: number): Point {
  const first = station(g, 0).center;
  const current = station(g, fraction * g.parameterEnd);
  const offset = first.vectorTo(plane.origin).add(plane.xDirection.multiply(u)).add(plane.yDirection.multiply(v));
  return current.center.add(current.rotate(offset));
}

/** Intervals on [low, high] for which a*u²+b*u+c <= 0. */
function insideQuadratic(a: number, b: number, c: number, low: number, high: number): [number, number][] {
  if (low >= high) return [];
  const clip = (lo: number, hi: number): [number, number][] => {
    lo = Math.max(lo, low); hi = Math.min(hi, high);
    return lo < hi ? [[lo, hi]] : [];
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return c <= 0 ? [[low, high]] : [];
    return b > 0 ? clip(-Infinity, -c / b) : clip(-c / b, Infinity);
  }
  const d = b * b - 4 * a * c;
  if (d < 0) return a < 0 ? [[low, high]] : [];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(d));
  const roots = q === 0 ? [0, 0] : [q / a, c / q];
  const lo = Math.min(...roots), hi = Math.max(...roots);
  return a > 0 ? clip(lo, hi) : [...clip(-Infinity, lo), ...clip(hi, Infinity)];
}

/**
 * Integrate the analytic sweep-map Jacobian over the authored trapezoid,
 * clipped by the analytic R25/H50 drafted stock. U clipping is quadratic
 * and integrated exactly; Simpson integration handles station and V.
 * This is a volume oracle, not a self-interference checker.
 */
export function coneSweepVolume(g: ResolvedHelixGeometry, plane: Plane, draft = 8, intervals = 400, clipped = true): number {
  const k = Math.tan(draft * Math.PI / 180);
  const initial = station(g, 0).center;
  const offset = initial.vectorTo(plane.origin);
  const dt = g.parameterEnd / intervals, dv = 5 / intervals;
  const weight = (i: number) => i === 0 || i === intervals ? 1 : i % 2 ? 4 : 2;
  let total = 0;
  for (let i = 0; i <= intervals; i++) {
    const frame = station(g, dt * i);
    const center = frame.center.add(frame.rotate(offset));
    const u = frame.rotate(plane.xDirection), v = frame.rotate(plane.yDirection), n = frame.rotate(plane.normal);
    const rotatedOffset = frame.rotate(offset);
    const j0 = n.dot(frame.derivative) + frame.rate * n.dot(g.frame.mainDirection.cross(rotatedOffset));
    const ju = frame.rate * n.dot(g.frame.mainDirection.cross(u));
    const jv = frame.rate * n.dot(g.frame.mainDirection.cross(v));
    let section = 0;
    for (let j = 0; j <= intervals; j++) {
      const vv = -3 + j * dv;
      const halfWidth = 2.5 - (vv + 3) * Math.tan(Math.PI / 12);
      const base = center.add(v.multiply(vv));
      let low = -halfWidth, high = halfWidth;
      if (clipped) {
        if (Math.abs(u.z) < 1e-12) { if (base.z < 0 || base.z > 50) continue; }
        else {
          const a = -base.z / u.z, b = (50 - base.z) / u.z;
          low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
        }
      }
      const radius = 25 + k * base.z;
      const spans = clipped ? insideQuadratic(
        u.x ** 2 + u.y ** 2 - (k * u.z) ** 2,
        2 * (base.x * u.x + base.y * u.y - radius * k * u.z),
        base.x ** 2 + base.y ** 2 - radius ** 2, low, high,
      ) : [[low, high]];
      const baseJacobian = j0 + jv * vv;
      let integral = 0;
      for (const [lo, hi] of spans) {
        const primitive = (q: number) => baseJacobian * q + ju * q * q / 2;
        const zero = ju === 0 ? Infinity : -baseJacobian / ju;
        integral += zero > lo && zero < hi
          ? Math.abs(primitive(zero) - primitive(lo)) + Math.abs(primitive(hi) - primitive(zero))
          : Math.abs(primitive(hi) - primitive(lo));
      }
      section += weight(j) * integral;
    }
    total += weight(i) * section * dv / 3;
  }
  return total * dt / 3;
}
