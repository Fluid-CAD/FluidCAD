// The assembly solver's own vector math.
//
// The solver runs wherever the engine does — Node and a browser worker — so
// it cannot lean on the viewer's 3D library. These are the three classes it
// needs: mutable (the solve loop reuses and chains them, so an immutable
// type would allocate on every step) and with the method names, argument
// order and arithmetic of the three.js classes the solver was written
// against. A solve therefore gives the same numbers on both sides.
//
// The classes are nominal ({@link Vector3} and {@link Quaternion} carry a
// private brand): a three.js vector looks the same structurally but is not
// the same thing — three's quaternion keeps its components in private
// fields its own methods read — so one is never accepted where a solver
// value is expected. Arguments that are only READ take the plain
// {@link Vec3Like} / {@link QuatLike} shapes, which any vector satisfies;
// a value the solver keeps or mutates is built with `new Vector3().copy(v)`.

/** Anything with `x`, `y`, `z` — read, never kept. */
export type Vec3Like = { readonly x: number; readonly y: number; readonly z: number };

/** Anything with `x`, `y`, `z`, `w` — read, never kept. */
export type QuatLike = { readonly x: number; readonly y: number; readonly z: number; readonly w: number };

export class Vector3 {
  declare private readonly assemblySolverVector: true;

  constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  copy(v: Vec3Like): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v: Vec3Like): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v: Vec3Like): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  /** `this += v · s`. */
  addScaledVector(v: Vec3Like, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v: Vec3Like): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  /** Scale to unit length; the zero vector stays zero. */
  normalize(): this {
    return this.multiplyScalar(1 / (this.length() || 1));
  }

  distanceTo(v: Vec3Like): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** `this = this × v`. */
  cross(v: Vec3Like): this {
    return this.crossVectors(this, v);
  }

  /** `this = a × b`. */
  crossVectors(a: Vec3Like, b: Vec3Like): this {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  /** Rotate by a UNIT quaternion. */
  applyQuaternion(q: QuatLike): this {
    const vx = this.x, vy = this.y, vz = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    // t = 2 · (q.xyz × v);  v' = v + q.w · t + q.xyz × t
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    this.x = vx + qw * tx + qy * tz - qz * ty;
    this.y = vy + qw * ty + qz * tx - qx * tz;
    this.z = vz + qw * tz + qx * ty - qy * tx;
    return this;
  }

  /** Rotate by `angle` radians about a UNIT `axis`. */
  applyAxisAngle(axis: Vec3Like, angle: number): this {
    return this.applyQuaternion(new Quaternion().setFromAxisAngle(axis, angle));
  }
}

export class Quaternion {
  declare private readonly assemblySolverQuaternion: true;

  /** The identity rotation by default. */
  constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0,
    public w: number = 1,
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  clone(): Quaternion {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  copy(q: QuatLike): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  /** The rotation by `angle` radians about a UNIT `axis`. */
  setFromAxisAngle(axis: Vec3Like, angle: number): this {
    const halfAngle = angle / 2;
    const s = Math.sin(halfAngle);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(halfAngle);
    return this;
  }

  /** The rotation a pure (unscaled) rotation matrix carries. */
  setFromRotationMatrix(m: Matrix3): this {
    const te = m.elements;
    const m11 = te[0], m12 = te[3], m13 = te[6];
    const m21 = te[1], m22 = te[4], m23 = te[7];
    const m31 = te[2], m32 = te[5], m33 = te[8];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }
    return this;
  }

  /** The opposite rotation — the conjugate, which inverts a UNIT quaternion. */
  invert(): this {
    this.x *= -1;
    this.y *= -1;
    this.z *= -1;
    return this;
  }

  /** `this = this · q` — `q` applies first. */
  multiply(q: QuatLike): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  dot(q: QuatLike): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
  }

  /** Scale to unit length; the zero quaternion becomes the identity. */
  normalize(): this {
    const length = this.length();
    if (length === 0) {
      return this.set(0, 0, 0, 1);
    }
    const scale = 1 / length;
    this.x *= scale;
    this.y *= scale;
    this.z *= scale;
    this.w *= scale;
    return this;
  }
}

/** A 3×3 matrix in column-major order — the solver only builds rotations with it. */
export class Matrix3 {
  readonly elements: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  /** The matrix whose columns are the three axes. */
  makeBasis(xAxis: Vec3Like, yAxis: Vec3Like, zAxis: Vec3Like): this {
    const te = this.elements;
    te[0] = xAxis.x; te[3] = yAxis.x; te[6] = zAxis.x;
    te[1] = xAxis.y; te[4] = yAxis.y; te[7] = zAxis.y;
    te[2] = xAxis.z; te[5] = yAxis.z; te[8] = zAxis.z;
    return this;
  }

  clone(): Matrix3 {
    const out = new Matrix3();
    for (let i = 0; i < 9; i++) {
      out.elements[i] = this.elements[i];
    }
    return out;
  }

  transpose(): this {
    const te = this.elements;
    let tmp = te[1]; te[1] = te[3]; te[3] = tmp;
    tmp = te[2]; te[2] = te[6]; te[6] = tmp;
    tmp = te[5]; te[5] = te[7]; te[7] = tmp;
    return this;
  }

  /** `this = a · b`. */
  multiplyMatrices(a: Matrix3, b: Matrix3): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;
    const a11 = ae[0], a12 = ae[3], a13 = ae[6];
    const a21 = ae[1], a22 = ae[4], a23 = ae[7];
    const a31 = ae[2], a32 = ae[5], a33 = ae[8];
    const b11 = be[0], b12 = be[3], b13 = be[6];
    const b21 = be[1], b22 = be[4], b23 = be[7];
    const b31 = be[2], b32 = be[5], b33 = be[8];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31;
    te[3] = a11 * b12 + a12 * b22 + a13 * b32;
    te[6] = a11 * b13 + a12 * b23 + a13 * b33;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31;
    te[4] = a21 * b12 + a22 * b22 + a23 * b32;
    te[7] = a21 * b13 + a22 * b23 + a23 * b33;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31;
    te[5] = a31 * b12 + a32 * b22 + a33 * b32;
    te[8] = a31 * b13 + a32 * b23 + a33 * b33;
    return this;
  }
}
