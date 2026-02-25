import { Vector3d } from "./vector3d.js";
import { Point } from "./point.js";
import { Quaternion } from "./quaternion.js";

/**
 * 4x4 transformation matrix stored in column-major order.
 * Layout:
 *   [0]  [4]  [8]  [12]     m00 m01 m02 m03
 *   [1]  [5]  [9]  [13]  =  m10 m11 m12 m13
 *   [2]  [6]  [10] [14]     m20 m21 m22 m23
 *   [3]  [7]  [11] [15]     m30 m31 m32 m33
 */
export class Matrix4 {
  public readonly elements: readonly number[];

  constructor(elements?: number[]) {
    if (elements) {
      if (elements.length !== 16) {
        throw new Error("Matrix4 requires exactly 16 elements");
      }
      this.elements = Object.freeze([...elements]);
    } else {
      this.elements = Object.freeze([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
    }
  }

  get(row: number, col: number): number {
    return this.elements[col * 4 + row];
  }

  multiply(other: Matrix4): Matrix4 {
    const a = this.elements;
    const b = other.elements;
    const result = new Array(16);

    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        result[col * 4 + row] =
          a[row] * b[col * 4] +
          a[4 + row] * b[col * 4 + 1] +
          a[8 + row] * b[col * 4 + 2] +
          a[12 + row] * b[col * 4 + 3];
      }
    }

    return new Matrix4(result);
  }

  premultiply(other: Matrix4): Matrix4 {
    return other.multiply(this);
  }

  determinant(): number {
    const m = this.elements;

    const n11 = m[0], n12 = m[4], n13 = m[8], n14 = m[12];
    const n21 = m[1], n22 = m[5], n23 = m[9], n24 = m[13];
    const n31 = m[2], n32 = m[6], n33 = m[10], n34 = m[14];
    const n41 = m[3], n42 = m[7], n43 = m[11], n44 = m[15];

    return (
      n41 * (
        n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 +
        n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34
      ) +
      n42 * (
        n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 -
        n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31
      ) +
      n43 * (
        n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 +
        n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31
      ) +
      n44 * (
        -n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 +
        n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31
      )
    );
  }

  inverse(): Matrix4 {
    const m = this.elements;
    const result = new Array(16);

    const n11 = m[0], n12 = m[4], n13 = m[8], n14 = m[12];
    const n21 = m[1], n22 = m[5], n23 = m[9], n24 = m[13];
    const n31 = m[2], n32 = m[6], n33 = m[10], n34 = m[14];
    const n41 = m[3], n42 = m[7], n43 = m[11], n44 = m[15];

    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;

    if (det === 0) {
      throw new Error("Matrix is not invertible (determinant is zero)");
    }

    const detInv = 1 / det;

    result[0] = t11 * detInv;
    result[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    result[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    result[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;

    result[4] = t12 * detInv;
    result[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    result[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    result[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;

    result[8] = t13 * detInv;
    result[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    result[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    result[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;

    result[12] = t14 * detInv;
    result[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    result[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    result[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;

    return new Matrix4(result);
  }

  transpose(): Matrix4 {
    const m = this.elements;
    return new Matrix4([
      m[0], m[4], m[8], m[12],
      m[1], m[5], m[9], m[13],
      m[2], m[6], m[10], m[14],
      m[3], m[7], m[11], m[15],
    ]);
  }

  transformPoint(p: Point): Point {
    const m = this.elements;
    const x = p.x, y = p.y, z = p.z;
    const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);

    return new Point(
      (m[0] * x + m[4] * y + m[8] * z + m[12]) * w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) * w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) * w
    );
  }

  transformVector(v: Vector3d): Vector3d {
    const m = this.elements;
    const x = v.x, y = v.y, z = v.z;

    return new Vector3d(
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z
    );
  }

  transformDirection(v: Vector3d): Vector3d {
    return this.transformVector(v).normalize();
  }

  decompose(): { translation: Vector3d; rotation: Quaternion; scale: Vector3d } {
    const m = this.elements;

    const sx = new Vector3d(m[0], m[1], m[2]).length();
    const sy = new Vector3d(m[4], m[5], m[6]).length();
    const sz = new Vector3d(m[8], m[9], m[10]).length();

    const det = this.determinant();
    const signX = det < 0 ? -1 : 1;

    const translation = new Vector3d(m[12], m[13], m[14]);
    const scale = new Vector3d(sx * signX, sy, sz);

    const invSX = 1 / sx;
    const invSY = 1 / sy;
    const invSZ = 1 / sz;

    const rotationMatrix = [
      m[0] * invSX, m[1] * invSX, m[2] * invSX, 0,
      m[4] * invSY, m[5] * invSY, m[6] * invSY, 0,
      m[8] * invSZ, m[9] * invSZ, m[10] * invSZ, 0,
      0, 0, 0, 1,
    ];

    const rotation = Quaternion.fromRotationMatrix(rotationMatrix);

    return { translation, rotation, scale };
  }

  equals(other: Matrix4, tolerance: number = 0): boolean {
    for (let i = 0; i < 16; i++) {
      if (tolerance === 0) {
        if (this.elements[i] !== other.elements[i]) return false;
      } else {
        if (Math.abs(this.elements[i] - other.elements[i]) > tolerance) return false;
      }
    }
    return true;
  }

  clone(): Matrix4 {
    return new Matrix4([...this.elements]);
  }

  toArray(): number[] {
    return [...this.elements];
  }

  toString(): string {
    const m = this.elements;
    return `Matrix4(\n  ${m[0]}, ${m[4]}, ${m[8]}, ${m[12]}\n  ${m[1]}, ${m[5]}, ${m[9]}, ${m[13]}\n  ${m[2]}, ${m[6]}, ${m[10]}, ${m[14]}\n  ${m[3]}, ${m[7]}, ${m[11]}, ${m[15]}\n)`;
  }

  static identity(): Matrix4 {
    return new Matrix4();
  }

  static fromTranslation(x: number, y: number, z: number): Matrix4 {
    return new Matrix4([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      x, y, z, 1,
    ]);
  }

  static fromTranslationVector(v: Vector3d): Matrix4 {
    return Matrix4.fromTranslation(v.x, v.y, v.z);
  }

  static fromScale(x: number, y: number, z: number): Matrix4 {
    return new Matrix4([
      x, 0, 0, 0,
      0, y, 0, 0,
      0, 0, z, 0,
      0, 0, 0, 1,
    ]);
  }

  static fromUniformScale(s: number): Matrix4 {
    return Matrix4.fromScale(s, s, s);
  }

  static fromRotationX(angle: number): Matrix4 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Matrix4([
      1, 0, 0, 0,
      0, c, s, 0,
      0, -s, c, 0,
      0, 0, 0, 1,
    ]);
  }

  static fromRotationY(angle: number): Matrix4 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Matrix4([
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      0, 0, 0, 1,
    ]);
  }

  static fromRotationZ(angle: number): Matrix4 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Matrix4([
      c, s, 0, 0,
      -s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  }

  static fromAxisAngle(axis: Vector3d, angle: number): Matrix4 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const n = axis.normalize();
    const x = n.x, y = n.y, z = n.z;

    return new Matrix4([
      t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    ]);
  }

  static fromRotationAroundAxis(origin: Point, direction: Vector3d, angle: number): Matrix4 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const n = direction.normalize();
    const x = n.x, y = n.y, z = n.z;
    const px = origin.x, py = origin.y, pz = origin.z;

    const r00 = t * x * x + c;
    const r10 = t * x * y + s * z;
    const r20 = t * x * z - s * y;
    const r01 = t * x * y - s * z;
    const r11 = t * y * y + c;
    const r21 = t * y * z + s * x;
    const r02 = t * x * z + s * y;
    const r12 = t * y * z - s * x;
    const r22 = t * z * z + c;

    const tx = px - (r00 * px + r01 * py + r02 * pz);
    const ty = py - (r10 * px + r11 * py + r12 * pz);
    const tz = pz - (r20 * px + r21 * py + r22 * pz);

    return new Matrix4([
      r00, r10, r20, 0,
      r01, r11, r21, 0,
      r02, r12, r22, 0,
      tx, ty, tz, 1,
    ]);
  }

  static fromQuaternion(q: Quaternion): Matrix4 {
    return new Matrix4(q.toMatrix());
  }

  static fromEulerAngles(x: number, y: number, z: number): Matrix4 {
    const q = Quaternion.fromEulerAngles(x, y, z);
    return Matrix4.fromQuaternion(q);
  }

  static fromBasis(xAxis: Vector3d, yAxis: Vector3d, zAxis: Vector3d, origin: Point = Point.origin()): Matrix4 {
    return new Matrix4([
      xAxis.x, xAxis.y, xAxis.z, 0,
      yAxis.x, yAxis.y, yAxis.z, 0,
      zAxis.x, zAxis.y, zAxis.z, 0,
      origin.x, origin.y, origin.z, 1,
    ]);
  }

  static compose(translation: Vector3d, rotation: Quaternion, scale: Vector3d): Matrix4 {
    const rotMatrix = Matrix4.fromQuaternion(rotation);
    const scaleMatrix = Matrix4.fromScale(scale.x, scale.y, scale.z);
    const translationMatrix = Matrix4.fromTranslationVector(translation);

    return translationMatrix.multiply(rotMatrix).multiply(scaleMatrix);
  }

  static lookAt(eye: Point, target: Point, up: Vector3d = Vector3d.unitY()): Matrix4 {
    const zAxis = eye.vectorTo(target).normalize().negate();
    const xAxis = up.cross(zAxis).normalize();
    const yAxis = zAxis.cross(xAxis);

    return new Matrix4([
      xAxis.x, yAxis.x, zAxis.x, 0,
      xAxis.y, yAxis.y, zAxis.y, 0,
      xAxis.z, yAxis.z, zAxis.z, 0,
      -xAxis.dot(eye.toVector3d()), -yAxis.dot(eye.toVector3d()), -zAxis.dot(eye.toVector3d()), 1,
    ]);
  }

  static mirrorPoint(point: Point): Matrix4 {
    const px = point.x, py = point.y, pz = point.z;
    return new Matrix4([
      -1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, -1, 0,
      2 * px, 2 * py, 2 * pz, 1,
    ]);
  }

  static mirrorPlane(normal: Vector3d, pointOnPlane: Point): Matrix4 {
    const n = normal.normalize();
    const d = -n.dot(pointOnPlane.toVector3d());

    const a = n.x, b = n.y, c = n.z;

    return new Matrix4([
      1 - 2 * a * a, -2 * a * b, -2 * a * c, 0,
      -2 * a * b, 1 - 2 * b * b, -2 * b * c, 0,
      -2 * a * c, -2 * b * c, 1 - 2 * c * c, 0,
      -2 * a * d, -2 * b * d, -2 * c * d, 1,
    ]);
  }

  static mirrorAxis(axisOrigin: Point, axisDirection: Vector3d): Matrix4 {
    const d = axisDirection.normalize();
    const p = axisOrigin;

    const dx = d.x, dy = d.y, dz = d.z;
    const px = p.x, py = p.y, pz = p.z;

    const xx = dx * dx, yy = dy * dy, zz = dz * dz;
    const xy = dx * dy, xz = dx * dz, yz = dy * dz;

    return new Matrix4([
      2 * xx - 1, 2 * xy, 2 * xz, 0,
      2 * xy, 2 * yy - 1, 2 * yz, 0,
      2 * xz, 2 * yz, 2 * zz - 1, 0,
      2 * (px - xx * px - xy * py - xz * pz),
      2 * (py - xy * px - yy * py - yz * pz),
      2 * (pz - xz * px - yz * py - zz * pz),
      1,
    ]);
  }

  static fromArray(arr: number[]): Matrix4 {
    return new Matrix4(arr);
  }
}
