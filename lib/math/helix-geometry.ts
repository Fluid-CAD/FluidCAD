import { CoordinateSystem } from "./coordinate-system.js";
import type { Matrix4 } from "./matrix4.js";
import { Vector3d } from "./vector3d.js";

/** Authored helix: angle = winding * u; axial/radial advance is linear in u. */
export interface ResolvedHelixGeometry {
  readonly frame: CoordinateSystem;
  readonly startRadius: number;
  readonly endRadius: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly turns: number;
  readonly winding: 1 | -1;
  readonly parameterEnd: number;
}

/** Similarities preserve helices; shear/nonuniform scale invalidates this descriptor. */
export function transformHelixGeometry(geometry: ResolvedHelixGeometry, matrix: Matrix4): ResolvedHelixGeometry | null {
  const columns = [Vector3d.unitX(), Vector3d.unitY(), Vector3d.unitZ()].map(v => matrix.transformVector(v));
  const scale = columns[0].length();
  // unit: dimensionless, tests similarity of the linear transform.
  if (!Number.isFinite(scale) || scale <= 0 || columns.some(v => Math.abs(v.length() / scale - 1) > 1e-9)
    || [0, 1, 2].some(i => matrix.get(3, i) !== 0) || matrix.get(3, 3) !== 1
    || Math.abs(columns[0].dot(columns[1])) > 1e-9 * scale ** 2
    || Math.abs(columns[0].dot(columns[2])) > 1e-9 * scale ** 2
    || Math.abs(columns[1].dot(columns[2])) > 1e-9 * scale ** 2) return null;
  return {
    ...geometry,
    frame: new CoordinateSystem(matrix.transformPoint(geometry.frame.origin),
      matrix.transformDirection(geometry.frame.mainDirection), matrix.transformDirection(geometry.frame.xDirection)),
    startRadius: geometry.startRadius * scale, endRadius: geometry.endRadius * scale,
    zStart: geometry.zStart * scale, zEnd: geometry.zEnd * scale,
    // CoordinateSystem reconstructs a right-handed Y. A reflection therefore
    // reverses angular winding relative to the transformed axis and X ray.
    winding: matrix.determinant() < 0 ? (geometry.winding === 1 ? -1 : 1) : geometry.winding,
  };
}
