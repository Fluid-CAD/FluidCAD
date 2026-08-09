import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import part from "../core/part.js";
import insert from "../core/insert.js";
import { rect } from "../core/2d/index.js";
import { Part } from "../features/part.js";
import { Quaternion } from "../math/quaternion.js";
import { rad } from "../helpers/math-helpers.js";

// Pins the rotation convention the assembly gizmo's write-back relies on:
// the chain `.rotate('x',rx).rotate('y',ry).rotate('z',rz)` composes to
// Q = Rz·Ry·Rx (ZYX Tait-Bryan, matching three.js Euler order 'ZYX' on the
// UI side and Quaternion.fromEulerAngles here), and a trailing `.translate()`
// pins the position exactly. If a kernel change breaks either property, the
// gizmo would silently write wrong poses — these tests make it loud.

function buildBox(): Part {
  return part("box", () => {
    sketch("xy", () => rect(20, 20));
    extrude(10);
  }) as unknown as Part;
}

function startAssemblyWithPart(): { p: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const p = buildBox();
  const scene = getSceneManager().startAssemblyScene();
  return { p, scene };
}

type QuatLike = { x: number; y: number; z: number; w: number };

/** |q1·q2| — 1 for identical rotations regardless of quaternion sign. */
function absDot(a: QuatLike, b: QuatLike): number {
  return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
}

function chainQuaternion(p: Part, deg: [number, number, number]): QuatLike {
  const inst = insert(p);
  if (deg[0] !== 0) {
    inst.rotate("x", deg[0]);
  }
  if (deg[1] !== 0) {
    inst.rotate("y", deg[1]);
  }
  if (deg[2] !== 0) {
    inst.rotate("z", deg[2]);
  }
  return inst.record.quaternion;
}

const SAMPLES: Array<[number, number, number]> = [
  [30, 0, 0],
  [0, 45, 0],
  [0, 0, 60],
  [90, 0, 30],
  [33, -70, 12],
  [-120, 15, 170],
  [10, 89, -10],
];

const GIMBAL_SAMPLES: Array<[number, number, number]> = [
  [0, 90, 0],
  [45, 90, 0],
  [0, -90, 30],
];

describe("instance rotation convention", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("chain x→y→z equals Quaternion.fromEulerAngles (Q = Rz·Ry·Rx)", () => {
    const { p } = startAssemblyWithPart();
    for (const deg of [...SAMPLES, ...GIMBAL_SAMPLES]) {
      const chained = chainQuaternion(p, deg);
      const composed = Quaternion.fromEulerAngles(rad(deg[0]), rad(deg[1]), rad(deg[2]));
      expect(absDot(chained, composed), `angles ${deg.join(',')}`).toBeCloseTo(1, 10);
    }
  });

  it("toEulerAngles round-trips through the chain away from gimbal lock", () => {
    const { p } = startAssemblyWithPart();
    for (const deg of SAMPLES) {
      const q = Quaternion.fromEulerAngles(rad(deg[0]), rad(deg[1]), rad(deg[2]));
      const e = q.toEulerAngles();
      const rebuilt = chainQuaternion(p, [
        (e.x * 180) / Math.PI,
        (e.y * 180) / Math.PI,
        (e.z * 180) / Math.PI,
      ]);
      expect(absDot(q, rebuilt), `angles ${deg.join(',')}`).toBeCloseTo(1, 10);
    }
  });

  it("toEulerAngles is quaternion-sign-invariant (idempotent gizmo re-commits)", () => {
    const q = Quaternion.fromEulerAngles(rad(33), rad(-70), rad(12));
    const negated = new Quaternion(-q.x, -q.y, -q.z, -q.w);
    const a = q.toEulerAngles();
    const b = negated.toEulerAngles();
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.y).toBeCloseTo(b.y, 12);
    expect(a.z).toBeCloseTo(b.z, 12);
  });

  it("canonical rotate calls leave the position at the exact origin", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p).rotate("x", 33).rotate("y", -70).rotate("z", 12);
    expect(inst.record.position.x).toBe(0);
    expect(inst.record.position.y).toBe(0);
    expect(inst.record.position.z).toBe(0);
  });

  it("a trailing .translate() pins the position to its exact args", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p).rotate("x", 90).rotate("z", 45).translate(1.25, -2.5, 3.75);
    expect(inst.record.position).toEqual({ x: 1.25, y: -2.5, z: 3.75 });
  });
});
