import { Quaternion } from "./quaternion.js";
import { Vector3d } from "./vector3d.js";

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

/** A rigid placement: where a frame sits and how it is turned, relative to some parent frame. */
export type Pose = { position: Vec3; quaternion: Quat };

export const IDENTITY_POSE: Pose = {
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
};

function toQuaternion(q: Quat): Quaternion {
  return new Quaternion(q.x, q.y, q.z, q.w);
}

/** parent ∘ local — rotate the local offset into the parent frame, chain the rotations. */
export function composePose(parent: Pose, local: Pose): Pose {
  const pq = toQuaternion(parent.quaternion);
  const q = pq.multiply(toQuaternion(local.quaternion));
  const rotated = pq.rotateVector(new Vector3d(local.position.x, local.position.y, local.position.z));
  return {
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  };
}

/** The pose that undoes `pose`: compose(pose, invert(pose)) is the identity. */
export function invertPose(pose: Pose): Pose {
  const inv = toQuaternion(pose.quaternion).normalize().conjugate();
  const p = inv.rotateVector(new Vector3d(pose.position.x, pose.position.y, pose.position.z));
  return {
    position: { x: -p.x, y: -p.y, z: -p.z },
    quaternion: { x: inv.x, y: inv.y, z: inv.z, w: inv.w },
  };
}

/**
 * `child` expressed in `parent`'s frame — both given in the same (world)
 * frame. compose(parent, relativePose(parent, child)) reproduces `child`.
 */
export function relativePose(parentWorld: Pose, childWorld: Pose): Pose {
  return composePose(invertPose(parentWorld), childWorld);
}
