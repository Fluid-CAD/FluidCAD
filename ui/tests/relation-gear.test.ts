import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  buildMateGraph,
  type BodyState,
  type ConnectorState,
  type MateRecord,
  type RelationRecord,
  type SolverOutput,
} from '../src/solver';

// A relation couples the free scalar of two mates. These tests drive one
// mate — by a grab-point drag or a kinematic driver — and check the other
// follows in ratio, for gears (rotation ↔ rotation) and rack-and-pinion
// (rotation ↔ slide), with the coupling's sign, its DOF accounting, the
// component merge across grounded bodies, and the failure report.

function connector(connectorId: string, origin: [number, number, number], normal: [number, number, number] = [0, 0, 1]): ConnectorState {
  const z = new Vector3(...normal).normalize();
  const x = Math.abs(z.z) < 0.9 ? new Vector3(0, 0, 1).cross(z).normalize() : new Vector3(1, 0, 0);
  return {
    connectorId,
    localOrigin: new Vector3(...origin),
    localXDirection: x,
    localNormal: z,
  };
}

function body(instanceId: string, grounded: boolean, position: Vector3, connectors: ConnectorState[]): BodyState {
  return { instanceId, position, quaternion: new Quaternion(), grounded, connectors };
}

function mate(
  mateId: string,
  type: MateRecord['type'],
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type,
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

function gear(mateA: string, mateB: string, ratio: number, reverse = false): RelationRecord {
  return { relationId: `${mateA}~${mateB}`, type: 'gear', mateA, mateB, ratio, reverse };
}

/** Spin of a body about world Z, degrees, from its solved quaternion. */
function spinDeg(out: SolverOutput, id: string): number {
  const q = out.bodies.find(b => b.instanceId === id)!.quaternion;
  const x = new Vector3(1, 0, 0).applyQuaternion(q);
  return (Math.atan2(x.y, x.x) * 180) / Math.PI;
}

/** Expect two angles (degrees) equal modulo a full turn — 180° and −180° are the same pose. */
function expectAngle(actual: number, expected: number, digits = 3): void {
  const d = actual - expected;
  expect(d - 360 * Math.round(d / 360)).toBeCloseTo(0, digits);
}

function positionOf(out: SolverOutput, id: string): Vector3 {
  return out.bodies.find(b => b.instanceId === id)!.position;
}

/**
 * Two gears on one grounded plate: axles at x = 0 and x = 30, each gear a
 * revolute on its axle. The plate's axle frames and the gears' bore frames
 * all point +Z, so each gear's hinge angle is its spin about world Z.
 */
function gearPair(): { bodies: BodyState[]; mates: MateRecord[] } {
  const plate = body('plate', true, new Vector3(0, 0, 0), [
    connector('axle1', [0, 0, 0]),
    connector('axle2', [30, 0, 0]),
  ]);
  const g1 = body('g1', false, new Vector3(0, 0, 0), [connector('bore', [0, 0, 0])]);
  const g2 = body('g2', false, new Vector3(30, 0, 0), [connector('bore', [0, 0, 0])]);
  return {
    bodies: [plate, g1, g2],
    mates: [
      mate('m1', 'revolute', { i: 'plate', c: 'axle1' }, { i: 'g1', c: 'bore' }, { flip: true }),
      mate('m2', 'revolute', { i: 'plate', c: 'axle2' }, { i: 'g2', c: 'bore' }, { flip: true }),
    ],
  };
}

/** Rotate the grab point (10, 0, 0) of g1 about its axle to `deg` by a cursor drag, with the relation on. */
function dragG1To(deg: number, relations: RelationRecord[], scene = gearPair()): SolverOutput {
  const rad = (deg * Math.PI) / 180;
  return new Solver().solve({
    bodies: scene.bodies,
    mates: scene.mates,
    relations,
    draggedInstanceId: 'g1',
    draggedGrabLocal: new Vector3(10, 0, 0),
    draggedCursorWorld: new Vector3(10 * Math.cos(rad), 10 * Math.sin(rad), 0),
  });
}

describe('relation(gear)', () => {
  it('a gear pair with a relation has one degree of freedom', () => {
    const scene = gearPair();
    const without = new Solver().solve({ bodies: scene.bodies, mates: scene.mates });
    expect(without.dof).toBe(2);
    const out = new Solver().solve({ bodies: scene.bodies, mates: scene.mates, relations: [gear('m1', 'm2', 2)] });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
    expect(out.failedRelations).toEqual([]);
  });

  it('dragging one gear turns the other by the ratio, in the same sense', () => {
    const out = dragG1To(20, [gear('m1', 'm2', 2)]);
    expect(out.result).toBe('okay');
    expect(spinDeg(out, 'g1')).toBeCloseTo(20, 3);
    expect(spinDeg(out, 'g2')).toBeCloseTo(40, 3);
    // Both gears stay on their axles.
    expect(positionOf(out, 'g1').length()).toBeLessThan(1e-6);
    expect(positionOf(out, 'g2').distanceTo(new Vector3(30, 0, 0))).toBeLessThan(1e-6);
  });

  it('.reverse() turns the other gear the other way', () => {
    const out = dragG1To(20, [gear('m1', 'm2', 0.5, true)]);
    expect(spinDeg(out, 'g1')).toBeCloseTo(20, 3);
    expect(spinDeg(out, 'g2')).toBeCloseTo(-10, 3);
  });

  it('dragging the second gear drives the first through the inverse ratio', () => {
    const scene = gearPair();
    const rad = (30 * Math.PI) / 180;
    const out = new Solver().solve({
      bodies: scene.bodies,
      mates: scene.mates,
      relations: [gear('m1', 'm2', 3)],
      draggedInstanceId: 'g2',
      draggedGrabLocal: new Vector3(10, 0, 0),
      draggedCursorWorld: new Vector3(30 + 10 * Math.cos(rad), 10 * Math.sin(rad), 0),
    });
    expect(spinDeg(out, 'g2')).toBeCloseTo(30, 3);
    expect(spinDeg(out, 'g1')).toBeCloseTo(10, 3);
  });

  it('the coupling is incremental: it holds from wherever the parts stand', () => {
    const scene = gearPair();
    // Pre-pose g2 at 90° — the relation does not pull it back to 0.
    scene.bodies[2].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const settled = new Solver().solve({ bodies: scene.bodies, mates: scene.mates, relations: [gear('m1', 'm2', 2)] });
    expect(spinDeg(settled, 'g2')).toBeCloseTo(90, 3);
    expect(settled.failedRelations).toEqual([]);
    // Then a drag of g1 by 15° adds 30° to g2 on top of its 90°.
    const out = dragG1To(15, [gear('m1', 'm2', 2)], scene);
    expect(spinDeg(out, 'g1')).toBeCloseTo(15, 3);
    expect(spinDeg(out, 'g2')).toBeCloseTo(120, 3);
  });

  it('a kinematic driver on one mate moves the other mate by the ratio', () => {
    const scene = gearPair();
    const out = new Solver().solve({
      bodies: scene.bodies,
      mates: scene.mates,
      relations: [gear('m1', 'm2', 2)],
      drivenJoint: { mateId: 'm1', value: 25 },
    });
    expect(out.result).toBe('okay');
    expect(spinDeg(out, 'g1')).toBeCloseTo(25, 3);
    expect(spinDeg(out, 'g2')).toBeCloseTo(50, 3);
    // Driving the second mate turns the first, inversely (a fresh scene —
    // the solver poses its input bodies in place).
    const fresh = gearPair();
    const back = new Solver().solve({
      bodies: fresh.bodies,
      mates: fresh.mates,
      relations: [gear('m1', 'm2', 2)],
      drivenJoint: { mateId: 'm2', value: 60 },
    });
    expect(spinDeg(back, 'g2')).toBeCloseTo(60, 3);
    expect(spinDeg(back, 'g1')).toBeCloseTo(30, 3);
  });

  it('stays continuous across the ±180° cut of the driver', () => {
    const scene = gearPair();
    scene.bodies[1].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), (175 * Math.PI) / 180);
    scene.bodies[2].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), (262.5 * Math.PI) / 180);
    const out = dragG1To(-175, [gear('m1', 'm2', 1.5)], scene);
    // g1 went 175° → 185° (reads −175°); g2 followed by 15°: 262.5° → 277.5° (reads −82.5°).
    expectAngle(spinDeg(out, 'g1'), -175);
    expectAngle(spinDeg(out, 'g2'), -82.5);
    expect(out.failedRelations).toEqual([]);
  });

  it('merges the components of gears on two different grounded bodies', () => {
    const left = body('left', true, new Vector3(0, 0, 0), [connector('axle', [0, 0, 0])]);
    const right = body('right', true, new Vector3(30, 0, 0), [connector('axle', [0, 0, 0])]);
    const g1 = body('g1', false, new Vector3(0, 0, 0), [connector('bore', [0, 0, 0])]);
    const g2 = body('g2', false, new Vector3(30, 0, 0), [connector('bore', [0, 0, 0])]);
    const bodies = [left, g1, right, g2];
    const mates = [
      mate('m1', 'revolute', { i: 'left', c: 'axle' }, { i: 'g1', c: 'bore' }, { flip: true }),
      mate('m2', 'revolute', { i: 'right', c: 'axle' }, { i: 'g2', c: 'bore' }, { flip: true }),
    ];
    const graph = buildMateGraph(bodies, mates, undefined, [gear('m1', 'm2', 2)]);
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0].relations).toHaveLength(1);
    expect(graph.components[0].roots.map(r => r.instanceId)).toEqual(['left', 'right']);
    expect(graph.bodyComponent.get('g2')).toBe(0);
    const rad = (20 * Math.PI) / 180;
    const out = new Solver().solve({
      bodies, mates, relations: [gear('m1', 'm2', 2)],
      draggedInstanceId: 'g1',
      draggedGrabLocal: new Vector3(10, 0, 0),
      draggedCursorWorld: new Vector3(10 * Math.cos(rad), 10 * Math.sin(rad), 0),
    });
    expect(spinDeg(out, 'g1')).toBeCloseTo(20, 3);
    expect(spinDeg(out, 'g2')).toBeCloseTo(40, 3);
    expect(out.dof).toBe(1);
  });

  it('reports the relation failed when the driven motion cannot be followed', () => {
    const scene = gearPair();
    // g2 is held: a fastened closure to the plate leaves it no motion.
    scene.mates.push(mate('hold', 'fastened', { i: 'plate', c: 'axle2' }, { i: 'g2', c: 'bore' }, { flip: true }));
    const out = new Solver().solve({
      bodies: scene.bodies,
      mates: scene.mates,
      relations: [gear('m1', 'm2', 2)],
      drivenJoint: { mateId: 'm1', value: 30 },
    });
    expect(out.failedRelations).toEqual(['m1~m2']);
    expect(out.result).toBe('inconsistent');
  });

  it('drops (with a warning) a relation whose mate is missing or has nothing to couple', () => {
    const scene = gearPair();
    scene.mates.push(mate('fix', 'fastened', { i: 'plate', c: 'axle1' }, { i: 'g2', c: 'bore' }));
    const graph = buildMateGraph(scene.bodies, scene.mates, undefined, [
      gear('m1', 'missing', 2),
      gear('m1', 'fix', 2),
    ]);
    expect(graph.components.flatMap(c => c.relations)).toEqual([]);
    const out = new Solver().solve({
      bodies: scene.bodies, mates: scene.mates, relations: [gear('m1', 'missing', 2)],
    });
    expect(out.failedRelations).toEqual([]);
  });
});

describe('relation(rack-and-pinion)', () => {
  /** A pinion on the plate's axle (+Z) and a rack on its rail, sliding along world X. */
  function rackScene(): { bodies: BodyState[]; mates: MateRecord[]; relation: RelationRecord } {
    const plate = body('plate', true, new Vector3(0, 0, 0), [
      connector('axle', [0, 0, 0]),
      connector('rail', [0, 20, 0], [1, 0, 0]),
    ]);
    const pinion = body('pinion', false, new Vector3(0, 0, 0), [connector('bore', [0, 0, 0])]);
    const rack = body('rack', false, new Vector3(0, 20, 0), [connector('slot', [0, 0, 0], [1, 0, 0])]);
    return {
      bodies: [plate, pinion, rack],
      mates: [
        mate('spin', 'revolute', { i: 'plate', c: 'axle' }, { i: 'pinion', c: 'bore' }, { flip: true }),
        mate('travel', 'slider', { i: 'plate', c: 'rail' }, { i: 'rack', c: 'slot' }, { flip: true }),
      ],
      // 36 mm per revolution: a 10° turn moves the rack 1 mm along the rail's Z.
      relation: { relationId: 'rp', type: 'rack-and-pinion', mateA: 'spin', mateB: 'travel', ratio: 36, reverse: false },
    };
  }

  it('turning the pinion moves the rack by the travel per revolution', () => {
    const scene = rackScene();
    const out = new Solver().solve({
      bodies: scene.bodies, mates: scene.mates, relations: [scene.relation],
      drivenJoint: { mateId: 'spin', value: 90 },
    });
    expect(out.result).toBe('okay');
    expect(spinDeg(out, 'pinion')).toBeCloseTo(90, 3);
    expect(positionOf(out, 'rack').x).toBeCloseTo(9, 3);
    expect(positionOf(out, 'rack').y).toBeCloseTo(20, 6);
    // The driven solve reports the pinion as held; a plain solve counts the one shared DOF.
    expect(out.dof).toBe(0);
    const plain = rackScene();
    expect(new Solver().solve({ bodies: plain.bodies, mates: plain.mates, relations: [plain.relation] }).dof).toBe(1);
  });

  it('sliding the rack turns the pinion, and .reverse() runs it the other way', () => {
    const scene = rackScene();
    const slid = new Solver().solve({
      bodies: scene.bodies, mates: scene.mates, relations: [scene.relation],
      drivenJoint: { mateId: 'travel', value: 18 },
    });
    expect(positionOf(slid, 'rack').x).toBeCloseTo(18, 3);
    expectAngle(spinDeg(slid, 'pinion'), 180, 2);
    const fresh = rackScene();
    const reversed = new Solver().solve({
      bodies: fresh.bodies, mates: fresh.mates, relations: [{ ...fresh.relation, reverse: true }],
      drivenJoint: { mateId: 'spin', value: 45 },
    });
    expect(positionOf(reversed, 'rack').x).toBeCloseTo(-4.5, 3);
  });

  it('couples a cylindrical rack side through its slide', () => {
    const scene = rackScene();
    scene.mates[1] = { ...scene.mates[1], type: 'cylindrical' };
    const out = new Solver().solve({
      bodies: scene.bodies, mates: scene.mates, relations: [scene.relation],
      drivenJoint: { mateId: 'spin', value: 180 },
    });
    expect(positionOf(out, 'rack').x).toBeCloseTo(18, 3);
    expect(out.failedRelations).toEqual([]);
  });
});
