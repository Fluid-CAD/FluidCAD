import { Vec3, Quat } from "../rendering/assembly-scene.js";
import { AxisLike, toAxis } from "../math/axis.js";
import { Quaternion } from "../math/quaternion.js";
import { Vector3d } from "../math/vector3d.js";
import { rad } from "../helpers/math-helpers.js";

/** The record slice the shared insert-handle chain API mutates. */
export type PoseRecord = {
  position: Vec3;
  quaternion: Quat;
  grounded: boolean;
  name: string;
};

/**
 * Chain API shared by the two `insert()` handles — `Instance` (a part) and
 * `Occurrence` (a sub-assembly): `.translate(...).rotate(...).grounded()
 * .name(...)` in any order. The pose written here is the warm-start pose,
 * LOCAL to the record's owning scope; world composition across occurrence
 * frames happens at serialize time (AssemblyScene.getSerializedInstances).
 *
 * `.grounded()` is likewise scope-relative: on an Instance it fixes the part
 * in the assembly that declared it (its anchor); on an Occurrence it fixes
 * that sub-assembly's frame in ITS parent scope. World grounding only
 * results when the chain of declarations reaches the root scope.
 */
export abstract class PoseHandle<R extends PoseRecord> {
  constructor(public readonly record: R) {}

  grounded(): this {
    this.record.grounded = true;
    return this;
  }

  name(value: string): this {
    this.record.name = value;
    return this;
  }

  translate(x: number, y: number = 0, z: number = 0): this {
    this.record.position = { x, y, z };
    return this;
  }

  rotate(axis: AxisLike, angleDegrees: number): this {
    const a = toAxis(axis);
    const rotQ = Quaternion.fromAxisAngle(a.direction, rad(angleDegrees));

    const cur = this.record.quaternion;
    const newQ = rotQ.multiply(new Quaternion(cur.x, cur.y, cur.z, cur.w));
    this.record.quaternion = { x: newQ.x, y: newQ.y, z: newQ.z, w: newQ.w };

    const p = this.record.position;
    const offset = new Vector3d(p.x - a.origin.x, p.y - a.origin.y, p.z - a.origin.z);
    const rotated = rotQ.rotateVector(offset);
    this.record.position = {
      x: a.origin.x + rotated.x,
      y: a.origin.y + rotated.y,
      z: a.origin.z + rotated.z,
    };

    return this;
  }
}
