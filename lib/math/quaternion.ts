import { Vector3d } from "./vector3d.js";

export class Quaternion {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
    public readonly w: number
  ) {}

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
  }

  lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  normalize(): Quaternion {
    const len = this.length();
    if (len === 0) {
      return Quaternion.identity();
    }
    return new Quaternion(this.x / len, this.y / len, this.z / len, this.w / len);
  }

  conjugate(): Quaternion {
    return new Quaternion(-this.x, -this.y, -this.z, this.w);
  }

  inverse(): Quaternion {
    const lenSq = this.lengthSquared();
    if (lenSq === 0) {
      return Quaternion.identity();
    }
    return new Quaternion(
      -this.x / lenSq,
      -this.y / lenSq,
      -this.z / lenSq,
      this.w / lenSq
    );
  }

  multiply(other: Quaternion): Quaternion {
    return new Quaternion(
      this.w * other.x + this.x * other.w + this.y * other.z - this.z * other.y,
      this.w * other.y - this.x * other.z + this.y * other.w + this.z * other.x,
      this.w * other.z + this.x * other.y - this.y * other.x + this.z * other.w,
      this.w * other.w - this.x * other.x - this.y * other.y - this.z * other.z
    );
  }

  dot(other: Quaternion): number {
    return this.x * other.x + this.y * other.y + this.z * other.z + this.w * other.w;
  }

  rotateVector(v: Vector3d): Vector3d {
    const qv = new Quaternion(v.x, v.y, v.z, 0);
    const result = this.multiply(qv).multiply(this.conjugate());
    return new Vector3d(result.x, result.y, result.z);
  }

  slerp(other: Quaternion, t: number): Quaternion {
    let cosHalfTheta = this.dot(other);

    let otherQ = other;
    if (cosHalfTheta < 0) {
      otherQ = new Quaternion(-other.x, -other.y, -other.z, -other.w);
      cosHalfTheta = -cosHalfTheta;
    }

    if (cosHalfTheta >= 1.0) {
      return this.clone();
    }

    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

    if (Math.abs(sinHalfTheta) < 0.001) {
      return new Quaternion(
        this.x * 0.5 + otherQ.x * 0.5,
        this.y * 0.5 + otherQ.y * 0.5,
        this.z * 0.5 + otherQ.z * 0.5,
        this.w * 0.5 + otherQ.w * 0.5
      );
    }

    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    return new Quaternion(
      this.x * ratioA + otherQ.x * ratioB,
      this.y * ratioA + otherQ.y * ratioB,
      this.z * ratioA + otherQ.z * ratioB,
      this.w * ratioA + otherQ.w * ratioB
    );
  }

  equals(other: Quaternion, tolerance: number = 0): boolean {
    if (tolerance === 0) {
      return (
        this.x === other.x &&
        this.y === other.y &&
        this.z === other.z &&
        this.w === other.w
      );
    }
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance &&
      Math.abs(this.z - other.z) <= tolerance &&
      Math.abs(this.w - other.w) <= tolerance
    );
  }

  toAxisAngle(): { axis: Vector3d; angle: number } {
    const q = this.lengthSquared() !== 1 ? this.normalize() : this;
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, q.w)));
    const sinHalfAngle = Math.sqrt(1 - q.w * q.w);

    if (sinHalfAngle < 0.0001) {
      return { axis: Vector3d.unitX(), angle: 0 };
    }

    return {
      axis: new Vector3d(
        q.x / sinHalfAngle,
        q.y / sinHalfAngle,
        q.z / sinHalfAngle
      ),
      angle,
    };
  }

  toEulerAngles(): { x: number; y: number; z: number } {
    const sinr_cosp = 2 * (this.w * this.x + this.y * this.z);
    const cosr_cosp = 1 - 2 * (this.x * this.x + this.y * this.y);
    const x = Math.atan2(sinr_cosp, cosr_cosp);

    const sinp = 2 * (this.w * this.y - this.z * this.x);
    let y: number;
    if (Math.abs(sinp) >= 1) {
      y = (Math.PI / 2) * (sinp < 0 ? -1 : 1);
    } else {
      y = Math.asin(sinp);
    }

    const siny_cosp = 2 * (this.w * this.z + this.x * this.y);
    const cosy_cosp = 1 - 2 * (this.y * this.y + this.z * this.z);
    const z = Math.atan2(siny_cosp, cosy_cosp);

    return { x, y, z };
  }

  toMatrix(): number[] {
    const x2 = this.x + this.x;
    const y2 = this.y + this.y;
    const z2 = this.z + this.z;

    const xx = this.x * x2;
    const xy = this.x * y2;
    const xz = this.x * z2;
    const yy = this.y * y2;
    const yz = this.y * z2;
    const zz = this.z * z2;
    const wx = this.w * x2;
    const wy = this.w * y2;
    const wz = this.w * z2;

    // Column-major order for 4x4 matrix
    return [
      1 - (yy + zz), xy + wz, xz - wy, 0,  // Column 0
      xy - wz, 1 - (xx + zz), yz + wx, 0,  // Column 1
      xz + wy, yz - wx, 1 - (xx + yy), 0,  // Column 2
      0, 0, 0, 1,                           // Column 3
    ];
  }

  clone(): Quaternion {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }

  toString(): string {
    return `Quaternion(${this.x}, ${this.y}, ${this.z}, ${this.w})`;
  }

  static identity(): Quaternion {
    return new Quaternion(0, 0, 0, 1);
  }

  static fromAxisAngle(axis: Vector3d, angle: number): Quaternion {
    const normalizedAxis = axis.normalize();
    const halfAngle = angle / 2;
    const sin = Math.sin(halfAngle);
    return new Quaternion(
      normalizedAxis.x * sin,
      normalizedAxis.y * sin,
      normalizedAxis.z * sin,
      Math.cos(halfAngle)
    );
  }

  static fromEulerAngles(x: number, y: number, z: number): Quaternion {
    const cx = Math.cos(x / 2);
    const sx = Math.sin(x / 2);
    const cy = Math.cos(y / 2);
    const sy = Math.sin(y / 2);
    const cz = Math.cos(z / 2);
    const sz = Math.sin(z / 2);

    return new Quaternion(
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz
    );
  }

  static fromRotationMatrix(m: number[]): Quaternion {
    // Column-major layout: m[col*4 + row]
    const m00 = m[0], m01 = m[4], m02 = m[8];
    const m10 = m[1], m11 = m[5], m12 = m[9];
    const m20 = m[2], m21 = m[6], m22 = m[10];

    const trace = m00 + m11 + m22;

    let x: number, y: number, z: number, w: number;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      w = 0.25 / s;
      x = (m21 - m12) * s;
      y = (m02 - m20) * s;
      z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
      w = (m21 - m12) / s;
      x = 0.25 * s;
      y = (m01 + m10) / s;
      z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
      w = (m02 - m20) / s;
      x = (m01 + m10) / s;
      y = 0.25 * s;
      z = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
      w = (m10 - m01) / s;
      x = (m02 + m20) / s;
      y = (m12 + m21) / s;
      z = 0.25 * s;
    }

    return new Quaternion(x, y, z, w);
  }

  static lookAt(forward: Vector3d, up: Vector3d = Vector3d.unitY()): Quaternion {
    const f = forward.normalize();
    const r = up.cross(f).normalize();
    const u = f.cross(r);

    const m00 = r.x, m01 = r.y, m02 = r.z;
    const m10 = u.x, m11 = u.y, m12 = u.z;
    const m20 = f.x, m21 = f.y, m22 = f.z;

    const trace = m00 + m11 + m22;
    let x: number, y: number, z: number, w: number;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      w = 0.25 / s;
      x = (m21 - m12) * s;
      y = (m02 - m20) * s;
      z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
      w = (m21 - m12) / s;
      x = 0.25 * s;
      y = (m01 + m10) / s;
      z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
      w = (m02 - m20) / s;
      x = (m01 + m10) / s;
      y = 0.25 * s;
      z = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
      w = (m10 - m01) / s;
      x = (m02 + m20) / s;
      y = (m12 + m21) / s;
      z = 0.25 * s;
    }

    return new Quaternion(x, y, z, w);
  }

  static fromArray(arr: [number, number, number, number]): Quaternion {
    return new Quaternion(arr[0], arr[1], arr[2], arr[3]);
  }
}
