import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver } from '../src/solver';
import { contactResidual, resolveContact } from '../src/solver/contact-model';
import type { BodyState, ContactEntity, ContactState, MateRecord } from '../src/solver/types';

// Zero-clearance pin-in-slot regression (the quick-return mechanism).
//
// A pin that exactly fills its slot (r = half-width) makes the slot's two
// OPPOSING walls tie in |gap| at every pose: their signed gaps are −y and
// +y. The active-pair pick used to tie-break on a strict `absGap <`, so
// ~1e-15 float noise flipped the winner between the residual, FD-probe,
// and trial evaluates of one LM solve — one wall's gradient got attached
// to the other wall's sign-flipped residual, the Gauss-Newton step
// reversed, every trial was rejected, and the arm froze while the crank
// followed the cursor ("Inconsistent — 1 mate failing" per pointermove).
// GAP_TIE_EPS makes the pick deterministic (earlier chain pair keeps a
// tie), so the emitted row is one wall's smooth signed gap.
//
// Geometry below is the real classified data captured from
// sample-cad/assembly/quick-return (Arm slot chain, Disc crank pin).

const PIN: ContactEntity = {
  form: 'cylinder',
  point: [20, 0, 102],
  dir: [-1, 0, 0],
  xDir: [0, 0, -1],
  radius: 4,
  convex: true,
  bounds: { uMin: -Math.PI, uMax: Math.PI, vMin: -10, vMax: 0 },
};

const ARM_CHAIN: ContactEntity[] = [
  {
    form: 'cylinder',
    point: [23, 0, 105],
    dir: [-1, 0, 0],
    xDir: [0, 0, -1],
    radius: 4,
    convex: false,
    bounds: { uMin: Math.PI / 2, uMax: (3 * Math.PI) / 2, vMin: -5, vMax: 0 },
  },
  {
    form: 'plane',
    point: [23, 4, 105],
    dir: [0, -1, 1.2297855042001735e-16],
    xDir: [0, 1.2297855042001735e-16, 1],
    convex: true,
    bounds: { uMin: -65, uMax: 0, vMin: -5, vMax: 0 },
  },
  {
    form: 'plane',
    point: [23, -4.000000000000008, 40],
    dir: [0, 1, -1.2297855042001735e-16],
    xDir: [0, -1.2297855042001735e-16, -1],
    convex: true,
    bounds: { uMin: -65, uMax: 0, vMin: -5, vMax: 0 },
  },
  {
    form: 'cylinder',
    point: [23, -7.960204194457796e-15, 40],
    dir: [-1, 0, 0],
    xDir: [0, 0, -1],
    radius: 4,
    convex: false,
    bounds: { uMin: (3 * Math.PI) / 2, uMax: (5 * Math.PI) / 2, vMin: -5, vMax: 0 },
  },
];

const armContacts: ContactState[] = [{ exposeName: 'g1', seed: ARM_CHAIN[0], chain: ARM_CHAIN }];
const pinContacts: ContactState[] = [{ exposeName: 'g1', seed: PIN, chain: [PIN] }];

function conn(
  id: string,
  o: [number, number, number],
  x: [number, number, number],
  n: [number, number, number],
) {
  return {
    connectorId: id,
    localOrigin: new Vector3(...o),
    localXDirection: new Vector3(...x),
    localNormal: new Vector3(...n),
  };
}

function makeBodies(): BodyState[] {
  return [
    {
      instanceId: 'base', grounded: true,
      position: new Vector3(), quaternion: new Quaternion(),
      connectors: [
        conn('c2', [20, 0, 72], [0, 1, 0], [1, 0, 0]),
        conn('c3', [28, 0, 20], [0, 1, 0], [1, 0, 0]),
      ],
      contacts: [],
    },
    {
      instanceId: 'disc', grounded: false,
      position: new Vector3(59.221497, 0, 0), quaternion: new Quaternion(),
      connectors: [conn('c1', [20, 0, 72], [0, 1, 0], [1, 0, 0])],
      contacts: pinContacts,
    },
    {
      instanceId: 'arm', grounded: false,
      position: new Vector3(113.122966, 0, 0), quaternion: new Quaternion(),
      connectors: [conn('c1', [28, 0, 20], [0, 1, 0], [1, 0, 0])],
      contacts: armContacts,
    },
  ];
}

const MATES: MateRecord[] = [
  {
    mateId: 'm-rev-disc', type: 'revolute',
    connectorA: { instanceId: 'disc', connectorId: 'c1' },
    connectorB: { instanceId: 'base', connectorId: 'c2' },
    options: { flip: true },
  },
  {
    mateId: 'm-rev-arm', type: 'revolute',
    connectorA: { instanceId: 'arm', connectorId: 'c1' },
    connectorB: { instanceId: 'base', connectorId: 'c3' },
    options: { flip: true },
  },
  {
    mateId: 'm-tangent', type: 'tangent',
    geometryA: { instanceId: 'arm', exposeName: 'g1' },
    geometryB: { instanceId: 'disc', exposeName: 'g1' },
  },
];

function cloneBodies(bodies: BodyState[]): BodyState[] {
  return bodies.map(b => ({
    ...b,
    position: b.position.clone(),
    quaternion: b.quaternion.clone(),
  }));
}

function tangentRows(bodies: BodyState[]): number[] {
  const rc = resolveContact(MATES[2], new Map(bodies.map(b => [b.instanceId, b])));
  expect(rc).not.toBeNull();
  return contactResidual(rc!);
}

/** Signed rotation angle about world X (both revolutes' axis). */
function angleAboutX(q: Quaternion): number {
  return 2 * Math.atan2(q.x, q.w);
}

describe('tangent mate — zero-clearance pin in a slot (quick-return)', () => {
  it('emits ONE wall\'s smooth signed gap, not a noise-picked |gap|', () => {
    const bodies = makeBodies();
    const settle = new Solver().solve({ bodies: cloneBodies(bodies), mates: MATES });
    expect(settle.result).toBe('okay');
    for (const sb of settle.bodies) {
      const b = bodies.find(p => p.instanceId === sb.instanceId)!;
      b.position.copy(sb.position);
      b.quaternion.copy(sb.quaternion);
    }

    // Offset the disc (pin) sideways in the slot by ±1 mm. Both walls tie
    // at |gap| = 1; the pick must stay on the SAME wall so the residual is
    // an odd (signed) function of the offset — the broken tie-break
    // returned +|y|-ish values with noise-random sign.
    const disc = bodies.find(b => b.instanceId === 'disc')!;
    const rowsAt = (dy: number): number[] => {
      const probe = cloneBodies(bodies);
      probe.find(b => b.instanceId === 'disc')!.position.copy(
        disc.position.clone().add(new Vector3(0, dy, 0)),
      );
      return tangentRows(probe);
    };
    const plus = rowsAt(1);
    const minus = rowsAt(-1);
    expect(Math.abs(plus[1])).toBeCloseTo(1, 6);
    expect(minus[1]).toBeCloseTo(-plus[1], 9);
    // Deterministic under sub-noise pose jitter.
    expect(rowsAt(1 + 1e-10)[1]).toBeCloseTo(plus[1], 6);
  });

  it('cranking the disc through a full revolution keeps the mate solved and the arm following', () => {
    const solver = new Solver();
    let poses = makeBodies();
    const settle = solver.solve({ bodies: cloneBodies(poses), mates: MATES });
    expect(settle.result).toBe('okay');
    for (const sb of settle.bodies) {
      const b = poses.find(p => p.instanceId === sb.instanceId)!;
      b.position.copy(sb.position);
      b.quaternion.copy(sb.quaternion);
    }

    const disc = poses.find(b => b.instanceId === 'disc')!;
    const center = new Vector3(20, 0, 72);
    const startGrabWorld = new Vector3(25, 0, 106);
    const grabLocal = startGrabWorld.clone()
      .sub(disc.position)
      .applyQuaternion(disc.quaternion.clone().invert());
    const grabOffset = disc.position.clone().sub(startGrabWorld);
    const rad = startGrabWorld.z - center.z;

    let armMin = Infinity;
    let armMax = -Infinity;
    // 2°-per-pointermove crank, controller-faithful: poses advance only on
    // an 'okay' result — with the broken tie-break this froze at frame 1.
    for (let i = 1; i <= 180; i++) {
      const phi = (i * 2 * Math.PI) / 180;
      const cursor = new Vector3(
        startGrabWorld.x,
        center.y + rad * Math.sin(phi),
        center.z + rad * Math.cos(phi),
      );
      const out = solver.solve({
        bodies: cloneBodies(poses),
        mates: MATES,
        draggedInstanceId: 'disc',
        draggedTargetOrigin: cursor.clone().add(grabOffset),
        draggedCursorWorld: cursor.clone(),
        draggedGrabLocal: grabLocal.clone(),
      });
      expect(out.result, `frame ${i}`).toBe('okay');
      const next = cloneBodies(poses);
      for (const sb of out.bodies) {
        const b = next.find(p => p.instanceId === sb.instanceId)!;
        b.position.copy(sb.position);
        b.quaternion.copy(sb.quaternion);
      }
      for (const v of tangentRows(next)) {
        expect(Math.abs(v), `frame ${i} tangent row`).toBeLessThan(1e-3);
      }
      poses = next;
      const arm = poses.find(b => b.instanceId === 'arm')!;
      const a = angleAboutX(arm.quaternion);
      armMin = Math.min(armMin, a);
      armMax = Math.max(armMax, a);
    }
    // The slotted arm oscillates ≈ 2·asin(30/52) ≈ 70° over one crank
    // revolution — it must actually FOLLOW, not sit frozen at 0 sweep.
    expect(((armMax - armMin) * 180) / Math.PI).toBeGreaterThan(40);
  });
});
