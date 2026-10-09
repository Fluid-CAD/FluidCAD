import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  buildMateGraph,
  isAcceptableDragFrame,
  mateReadoutValue,
  type BodyState,
  type ConnectorState,
  type MateRecord,
  type RelationRecord,
  type SolverInput,
  type SolverOutput,
} from '../src/solver';

// Relations are solved EXACTLY (relation-groups.ts): a drag can only move a
// coupled train the ways the train moves, so dragging a planet of a
// planetary set turns the whole set in ratio instead of slipping the mesh.
// These tests drive and drag gear trains frame by frame the way the
// assembly controller does, and check every relation at every frame.

const ZR = 60;
const ZS = 18;
const ZP = 21;
const R = 29.25;

function connector(connectorId: string, origin: [number, number, number], normal: [number, number, number] = [0, 0, 1]): ConnectorState {
  const z = new Vector3(...normal).normalize();
  const x = Math.abs(z.z) < 0.9 ? new Vector3(0, 0, 1).cross(z).normalize() : new Vector3(1, 0, 0);
  return { connectorId, localOrigin: new Vector3(...origin), localXDirection: x, localNormal: z };
}

function body(instanceId: string, grounded: boolean, position: Vector3, connectors: ConnectorState[]): BodyState {
  return { instanceId, position, quaternion: new Quaternion(), grounded, connectors };
}

function revolute(mateId: string, a: [string, string], b: [string, string], options: MateRecord['options'] = {}): MateRecord {
  return {
    mateId,
    type: 'revolute',
    connectorA: { instanceId: a[0], connectorId: a[1] },
    connectorB: { instanceId: b[0], connectorId: b[1] },
    options: { flip: true, ...options },
  };
}

function gear(relationId: string, mateA: string, mateB: string, ratio: number, reverse = false): RelationRecord {
  return { relationId, type: 'gear', mateA, mateB, ratio, reverse };
}

type Scene = { bodies: BodyState[]; mates: MateRecord[]; relations: RelationRecord[] };

/**
 * A planetary set on a grounded ring: the carrier and the sun turn on the
 * ring's axis, three planets on the carrier's pins. Relations: each planet
 * −ZR/ZP of the carrier (in the carrier's frame), the sun 1 + ZR/ZS of it.
 * `extra` appends relations (the six-relation and contradictory variants).
 */
function planetary(extra: RelationRecord[] = []): Scene {
  const pins: Array<[number, number, number]> = [0, 120, 240].map(d => {
    const r = (d * Math.PI) / 180;
    return [R * Math.cos(r), R * Math.sin(r), 0];
  });
  const bodies = [
    body('ring', true, new Vector3(), [connector('axis', [0, 0, 0])]),
    body('carrier', false, new Vector3(), [connector('axis', [0, 0, 0]), ...pins.map((p, i) => connector(`pin${i}`, p))]),
    body('sun', false, new Vector3(), [connector('axis', [0, 0, 0])]),
    ...pins.map((p, i) => body(`planet${i}`, false, new Vector3(...p), [connector('axis', [0, 0, 0])])),
  ];
  const mates = [
    revolute('carrier', ['ring', 'axis'], ['carrier', 'axis']),
    revolute('sun', ['ring', 'axis'], ['sun', 'axis']),
    ...[0, 1, 2].map(i => revolute(`pin${i}`, ['carrier', `pin${i}`], [`planet${i}`, 'axis'])),
  ];
  const relations = [
    ...[0, 1, 2].map(i => gear(`ring-planet${i}`, 'carrier', `pin${i}`, ZR / ZP, true)),
    gear('carrier-sun', 'carrier', 'sun', 1 + ZR / ZS),
    ...extra,
  ];
  return { bodies, mates, relations };
}

/** Each planet tied to the sun as well — consistent, so redundant. */
function sixRelations(sunRatioScale = 1): RelationRecord[] {
  // sun = (1 + ZR/ZS)·c and planet = −(ZR/ZP)·c ⇒ sun = −(1 + ZR/ZS)(ZP/ZR)·planet.
  const ratio = (1 + ZR / ZS) * (ZP / ZR) * sunRatioScale;
  return [0, 1, 2].map(i => gear(`planet${i}-sun`, `pin${i}`, 'sun', ratio, true));
}

function yaw(q: Quaternion): number {
  const x = new Vector3(1, 0, 0).applyQuaternion(q);
  return Math.atan2(x.y, x.x);
}

/** |a − b| modulo a full turn (radians). */
function angleGap(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d - 2 * Math.PI * Math.round(d / (2 * Math.PI)));
}

function cloneBodies(bodies: BodyState[]): BodyState[] {
  return bodies.map(b => ({ ...b, position: b.position.clone(), quaternion: b.quaternion.clone() }));
}

function applyOut(bodies: BodyState[], out: SolverOutput): void {
  for (const solved of out.bodies) {
    const b = bodies.find(x => x.instanceId === solved.instanceId);
    if (b) {
      b.position.copy(solved.position);
      b.quaternion.copy(solved.quaternion);
    }
  }
}

/** Every mate's authored-space readout (degrees / mm). */
function readouts(scene: Scene, bodies: BodyState[]): Map<string, number> {
  const graph = buildMateGraph(bodies, scene.mates);
  const out = new Map<string, number>();
  for (const c of graph.components) {
    for (const e of c.treeEdges) {
      const r = mateReadoutValue(e.mate, e.parent, e.parentConn, e.child, e.childConn);
      if (r) out.set(e.mate.mateId, r.value);
    }
  }
  return out;
}

/**
 * Drag `id` by its grab point (`grab` world offset from its centre at the
 * start) along `path(k)` — cursor world positions — one solve per step,
 * applying each acceptable frame like the controller does. Returns the
 * absolute spins (unwrapped, radians) of every body after each step.
 */
function dragAlong(
  scene: Scene,
  id: string,
  grab: Vector3,
  path: (k: number, grabStart: Vector3, centre: Vector3) => Vector3,
  steps: number,
): { accepted: number; okay: number; spins: Array<Map<string, number>>; outs: SolverOutput[]; bodies: BodyState[] } {
  const solver = new Solver();
  const bodies = cloneBodies(scene.bodies);
  applyOut(bodies, solver.solve({ bodies: cloneBodies(bodies), mates: scene.mates, relations: scene.relations }));
  const dragged = bodies.find(b => b.instanceId === id)!;
  const centre = dragged.position.clone();
  const grabWorld = centre.clone().add(grab);
  const grabLocal = grabWorld.clone().sub(dragged.position).applyQuaternion(dragged.quaternion.clone().invert());
  const unwrapped = new Map(bodies.map(b => [b.instanceId, yaw(b.quaternion)]));
  const spins: Array<Map<string, number>> = [];
  const outs: SolverOutput[] = [];
  let accepted = 0;
  let okay = 0;
  for (let k = 1; k <= steps; k++) {
    const cursor = path(k, grabWorld, centre);
    const input: SolverInput = {
      bodies: cloneBodies(bodies),
      mates: scene.mates,
      relations: scene.relations,
      draggedInstanceId: id,
      draggedCursorWorld: cursor,
      draggedGrabLocal: grabLocal.clone(),
    };
    const out = solver.solve(input);
    outs.push(out);
    if (out.result === 'okay') okay++;
    if (isAcceptableDragFrame(out)) {
      accepted++;
      applyOut(bodies, out);
    }
    for (const b of bodies) {
      const prev = unwrapped.get(b.instanceId)!;
      const now = yaw(b.quaternion);
      unwrapped.set(b.instanceId, now + 2 * Math.PI * Math.round((prev - now) / (2 * Math.PI)));
    }
    spins.push(new Map(unwrapped));
  }
  return { accepted, okay, spins, outs, bodies };
}

const deg = Math.PI / 180;
const orbit = (k: number, g: Vector3) => g.clone().applyAxisAngle(new Vector3(0, 0, 1), 1.5 * k * deg);
const spinAboutCentre = (k: number, g: Vector3, c: Vector3) =>
  g.clone().sub(c).applyAxisAngle(new Vector3(0, 0, 1), 1.5 * k * deg).add(c);
const line = (k: number, g: Vector3) => g.clone().add(new Vector3(0, 0.4 * k, 0));

/** The planetary's kinematics hold at every frame: sun = (1 + ZR/ZS)·c, planets = (1 − ZR/ZP)·c (absolute). */
function expectPlanetaryInRatio(spins: Array<Map<string, number>>): void {
  // Every body starts at rest (yaw 0), so absolute spins compare directly.
  for (const frame of spins) {
    const c = frame.get('carrier')!;
    expect(angleGap(frame.get('sun')!, (1 + ZR / ZS) * c)).toBeLessThan(1e-6);
    for (let i = 0; i < 3; i++) {
      // Planet i starts at rest (yaw 0) on its pin; absolute spin c + p.
      expect(angleGap(frame.get(`planet${i}`)!, (1 - ZR / ZP) * c)).toBeLessThan(1e-6);
    }
  }
}

describe('exact relations — dragging a planetary set from any part', () => {
  it('the set has one degree of freedom and settles without failures', () => {
    const scene = planetary();
    const out = new Solver().solve({ bodies: cloneBodies(scene.bodies), mates: scene.mates, relations: scene.relations });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
    expect(out.failedRelations).toEqual([]);
    expect(out.contradictedRelations).toEqual([]);
  });

  const drags: Array<[string, string, Vector3, typeof orbit]> = [
    ['planet 0, orbiting the ring centre', 'planet0', new Vector3(5, 0, 0), orbit],
    ['planet 1, off-centre grab orbiting', 'planet1', new Vector3(-3, 4, 0), orbit],
    ['planet 0, cursor circling its own pin', 'planet0', new Vector3(5, 0, 0), spinAboutCentre],
    ['planet 2, straight line', 'planet2', new Vector3(0, -6, 0), line],
    ['the sun about its axis', 'sun', new Vector3(8, 0, 0), spinAboutCentre],
    ['the carrier about the ring centre', 'carrier', new Vector3(20, 0, 0), orbit],
  ];
  for (const [name, id, grab, path] of drags) {
    it(`${name}: every frame is accepted and every relation holds, with no drift over 240 frames`, () => {
      const run = dragAlong(planetary(), id, grab, path, 240);
      expect(run.okay).toBe(240);
      expect(run.accepted).toBe(240);
      expect(run.outs.every(o => o.failedRelations.length === 0 && o.failed.length === 0)).toBe(true);
      expectPlanetaryInRatio(run.spins);
      // The train actually moved.
      const turned = Math.max(...run.spins.map(f => Math.abs(f.get('carrier')!)));
      expect(turned).toBeGreaterThan(5 * deg);
    });
  }

  it('dragging a planet around the ring carries the grab along with the cursor, smoothly', () => {
    const run = dragAlong(planetary(), 'planet0', new Vector3(5, 0, 0), orbit, 240);
    let maxStep = 0;
    for (let k = 1; k < run.spins.length; k++) {
      maxStep = Math.max(maxStep, Math.abs(run.spins[k].get('carrier')! - run.spins[k - 1].get('carrier')!));
    }
    // 1.5° of cursor per frame: the carrier never jumps more than a few degrees.
    expect(maxStep).toBeLessThan(4 * deg);
    // After a full lap of the cursor the carrier has come most of the way round.
    expect(run.spins.at(-1)!.get('carrier')!).toBeGreaterThan(300 * deg);
  });

  it('a grab exactly on a planet\'s pin moves only the carrier\'s orbit, exactly', () => {
    const run = dragAlong(planetary(), 'planet0', new Vector3(0, 0, 0), orbit, 60);
    expect(run.accepted).toBe(60);
    expectPlanetaryInRatio(run.spins);
    expect(run.spins.at(-1)!.get('carrier')!).toBeCloseTo(90 * deg, 6);
  });

  it('driving the carrier, the sun or a planet turns the whole set in ratio', () => {
    const scene = planetary();
    const solver = new Solver();
    const byCarrier = cloneBodies(scene.bodies);
    const out = solver.solve({ bodies: byCarrier, mates: scene.mates, relations: scene.relations, drivenJoint: { mateId: 'carrier', value: 30 } });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
    applyOut(byCarrier, out);
    const r = readouts(scene, byCarrier);
    expect(r.get('carrier')).toBeCloseTo(30, 9);
    expect(angleGap(r.get('sun')! * deg, 30 * (1 + ZR / ZS) * deg)).toBeLessThan(1e-9);
    for (let i = 0; i < 3; i++) expect(angleGap(r.get(`pin${i}`)! * deg, -30 * (ZR / ZP) * deg)).toBeLessThan(1e-9);

    const byPlanet = cloneBodies(scene.bodies);
    const outP = solver.solve({ bodies: byPlanet, mates: scene.mates, relations: scene.relations, drivenJoint: { mateId: 'pin1', value: 20 } });
    expect(outP.result).toBe('okay');
    applyOut(byPlanet, outP);
    const rp = readouts(scene, byPlanet);
    expect(rp.get('pin1')).toBeCloseTo(20, 9);
    expect(rp.get('carrier')).toBeCloseTo(-20 * (ZP / ZR), 9);
    expect(rp.get('pin0')).toBeCloseTo(20, 9);
    expect(rp.get('sun')).toBeCloseTo(-20 * (ZP / ZR) * (1 + ZR / ZS), 9);
  });

  it('a driven step past half a turn of the followers in one solve still holds every relation', () => {
    // 170° of carrier spins the sun 737° and each planet −486° in ONE solve:
    // beyond what the per-solve incremental measure can follow, so the
    // exact solve is trusted, not re-measured.
    const scene = planetary();
    const bodies = cloneBodies(scene.bodies);
    const out = new Solver().solve({ bodies, mates: scene.mates, relations: scene.relations, drivenJoint: { mateId: 'carrier', value: 170 } });
    expect(out.result).toBe('okay');
    expect(out.failedRelations).toEqual([]);
    applyOut(bodies, out);
    const c = 170 * deg;
    expect(angleGap(yaw(bodies.find(b => b.instanceId === 'sun')!.quaternion), (1 + ZR / ZS) * c)).toBeLessThan(1e-9);
    expect(angleGap(yaw(bodies.find(b => b.instanceId === 'planet2')!.quaternion), (1 - ZR / ZP) * c)).toBeLessThan(1e-9);
  });
});

describe('exact relations — redundant and contradictory sets', () => {
  it('six relations (each planet tied to both the ring and the sun) are redundant: one DOF, every drag exact', () => {
    const scene = planetary(sixRelations());
    const out = new Solver().solve({ bodies: cloneBodies(scene.bodies), mates: scene.mates, relations: scene.relations });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
    expect(out.failedRelations).toEqual([]);
    const run = dragAlong(scene, 'planet1', new Vector3(-3, 4, 0), orbit, 120);
    expect(run.okay).toBe(120);
    expectPlanetaryInRatio(run.spins);
  });

  it('a relation contradicting the others is reported on every solve, moving or not, and the rest stays exact', () => {
    // Planet 2's sun ratio is 1 % off: around the cycle it would lock the set.
    const extra = sixRelations();
    extra[2] = { ...extra[2], ratio: extra[2].ratio * 1.01 };
    const scene = planetary(extra);
    const rest = new Solver().solve({ bodies: cloneBodies(scene.bodies), mates: scene.mates, relations: scene.relations });
    expect(rest.failedRelations).toEqual(['planet2-sun']);
    expect(rest.contradictedRelations).toEqual(['planet2-sun']);
    expect(rest.result).toBe('inconsistent');
    expect(rest.failed).toEqual([]);
    expect(isAcceptableDragFrame(rest)).toBe(true);
    expect(rest.dof).toBe(1);
    // Dragging still moves the set, exactly, by the relations that agree.
    const run = dragAlong(scene, 'carrier', new Vector3(20, 0, 0), orbit, 40);
    expect(run.accepted).toBe(40);
    expect(run.outs.every(o => o.contradictedRelations.length === 1 && o.failedRelations.length === 1)).toBe(true);
    expectPlanetaryInRatio(run.spins);
  });

  it('the verdict is deterministic: the later relation closing the cycle is the one dropped', () => {
    const base = planetary().relations;
    const scene = planetary();
    // Reorder: the off relation first; the agreeing ones close the cycle later.
    const off = { ...sixRelations()[0], ratio: sixRelations()[0].ratio * 1.05 };
    scene.relations = [off, ...base];
    const out = new Solver().solve({ bodies: cloneBodies(scene.bodies), mates: scene.mates, relations: scene.relations });
    // carrier-sun is the relation that closes carrier → planet0 → sun.
    expect(out.contradictedRelations).toEqual(['carrier-sun']);
  });
});

/** Two gears on one grounded plate: axles at x = 0 and x = 30, each a revolute (see relation-gear.test.ts). */
function gearPair(options2: MateRecord['options'] = {}): Scene {
  return {
    bodies: [
      body('plate', true, new Vector3(), [connector('axle1', [0, 0, 0]), connector('axle2', [30, 0, 0]), connector('axle2b', [30, 0, 5])]),
      body('g1', false, new Vector3(), [connector('bore', [0, 0, 0])]),
      body('g2', false, new Vector3(30, 0, 0), [connector('bore', [0, 0, 0]), connector('bore2', [0, 0, 5])]),
    ],
    mates: [
      revolute('m1', ['plate', 'axle1'], ['g1', 'bore']),
      revolute('m2', ['plate', 'axle2'], ['g2', 'bore'], options2),
    ],
    relations: [gear('m1~m2', 'm1', 'm2', 2)],
  };
}

/** Turn g1's grab (10, 0, 0) about its axle by `steps` × `stepDeg`, one solve per step. */
function turnG1(scene: Scene, steps: number, stepDeg: number) {
  return dragAlong(scene, 'g1', new Vector3(10, 0, 0), (k, g) => g.clone().applyAxisAngle(new Vector3(0, 0, 1), k * stepDeg * deg), steps);
}

describe('exact relations — limits stop the whole train', () => {
  it('a limit on the follower stops the driver too, and the relation still holds', () => {
    const scene = gearPair({ limits: [-90, 90] });
    const run = turnG1(scene, 60, 1);
    expect(run.accepted).toBe(60);
    expect(run.outs.every(o => o.failedRelations.length === 0)).toBe(true);
    const last = run.spins.at(-1)!;
    // g2 turns twice g1: it reaches its 90° bound when g1 is at 45°, and both stop.
    expect(Math.abs(last.get('g2')!)).toBeCloseTo(90 * deg, 6);
    expect(Math.abs(last.get('g1')!)).toBeCloseTo(45 * deg, 6);
    expect(angleGap(last.get('g2')!, 2 * last.get('g1')!)).toBeLessThan(1e-9);
  });

  it('a limit at the ±180° cut pins the train at the bound instead of flipping across it', () => {
    // g2 is limited to [0, 180] (authored space) and starts at 170; turning
    // g1 on would carry g2 past 180, where the measured angle wraps to −180.
    const scene = gearPair({ limits: [0, 180] });
    const solver = new Solver();
    const bodies = cloneBodies(scene.bodies);
    applyOut(bodies, solver.solve({ bodies: cloneBodies(bodies), mates: scene.mates, relations: scene.relations, drivenJoint: { mateId: 'm2', value: 170 } }));
    expect(readouts(scene, bodies).get('m2')).toBeCloseTo(170, 9);
    expect(readouts(scene, bodies).get('m1')).toBeCloseTo(85, 9);
    let clamped = 0;
    for (const dir of [1, -1]) {
      const run = dragAlong({ ...scene, bodies }, 'g1', new Vector3(10, 0, 0),
        (k, g) => g.clone().applyAxisAngle(new Vector3(0, 0, 1), dir * k * deg), 30);
      expect(run.accepted).toBe(30);
      expect(run.outs.every(o => o.failedRelations.length === 0)).toBe(true);
      const r = readouts(scene, run.bodies);
      const m1 = r.get('m1')!;
      const m2 = r.get('m2')!;
      // On the bound or inside the box, never flipped to the far side.
      const m2Branch = m2 < -90 ? m2 + 360 : m2;
      expect(m2Branch).toBeGreaterThanOrEqual(-1e-6);
      expect(m2Branch).toBeLessThanOrEqual(180 + 1e-6);
      expect(m2Branch - 170).toBeCloseTo(2 * (m1 - 85), 6);
      if (Math.abs(m2Branch - 180) < 1e-6) {
        clamped++;
        expect(m1).toBeCloseTo(90, 6);
      }
    }
    expect(clamped).toBe(1);
  });

  it('a rack on a limited slider stops the pinion at the rack\'s end of travel', () => {
    const scene: Scene = {
      bodies: [
        body('plate', true, new Vector3(), [connector('axle', [0, 0, 0]), connector('rail', [0, 20, 0], [1, 0, 0])]),
        body('pinion', false, new Vector3(), [connector('bore', [0, 0, 0])]),
        body('rack', false, new Vector3(0, 20, 0), [connector('slot', [0, 0, 0], [1, 0, 0])]),
      ],
      mates: [
        revolute('spin', ['plate', 'axle'], ['pinion', 'bore']),
        { mateId: 'travel', type: 'slider', connectorA: { instanceId: 'plate', connectorId: 'rail' }, connectorB: { instanceId: 'rack', connectorId: 'slot' }, options: { flip: true, limits: [-5, 5] } },
      ],
      // 36 mm per revolution: 10° of pinion moves the rack 1 mm.
      relations: [{ relationId: 'rp', type: 'rack-and-pinion', mateA: 'spin', mateB: 'travel', ratio: 36, reverse: false }],
    };
    const run = dragAlong(scene, 'pinion', new Vector3(10, 0, 0), (k, g) => g.clone().applyAxisAngle(new Vector3(0, 0, 1), k * deg), 90);
    expect(run.accepted).toBe(90);
    expect(run.outs.every(o => o.failedRelations.length === 0)).toBe(true);
    // 5 mm of travel is 50° of pinion: both stop there.
    expect(run.spins.at(-1)!.get('pinion')!).toBeCloseTo(50 * deg, 6);

    // A DRIVER asking past the limit can't be honoured: the rack clamps and
    // the relation reports failed (the driven joint itself is held).
    const bodies = cloneBodies(scene.bodies);
    const out = new Solver().solve({ bodies, mates: scene.mates, relations: scene.relations, drivenJoint: { mateId: 'spin', value: 90 } });
    applyOut(bodies, out);
    expect(out.failedRelations).toEqual(['rp']);
    expect(out.result).toBe('inconsistent');
    expect(Math.abs(bodies[2].position.x)).toBeCloseTo(5, 6);
    expect(yaw(bodies[1].quaternion)).toBeCloseTo(90 * deg, 9);
  });
});

describe('exact relations — trains that already worked keep working', () => {
  it('a reducer chain (two relations in series) turns each stage by its ratio', () => {
    const scene: Scene = {
      bodies: [
        body('plate', true, new Vector3(), [connector('a1', [0, 0, 0]), connector('a2', [40, 0, 0]), connector('a3', [80, 0, 0])]),
        body('input', false, new Vector3(), [connector('bore', [0, 0, 0])]),
        body('mid', false, new Vector3(40, 0, 0), [connector('bore', [0, 0, 0])]),
        body('output', false, new Vector3(80, 0, 0), [connector('bore', [0, 0, 0])]),
      ],
      mates: [
        revolute('in', ['plate', 'a1'], ['input', 'bore']),
        revolute('mid', ['plate', 'a2'], ['mid', 'bore']),
        revolute('out', ['plate', 'a3'], ['output', 'bore']),
      ],
      relations: [gear('s1', 'in', 'mid', 14 / 42, true), gear('s2', 'mid', 'out', 14 / 42, true)],
    };
    const run = dragAlong(scene, 'input', new Vector3(10, 0, 0), (k, g) => g.clone().applyAxisAngle(new Vector3(0, 0, 1), k * deg), 90);
    expect(run.okay).toBe(90);
    const last = run.spins.at(-1)!;
    expect(last.get('input')!).toBeCloseTo(90 * deg, 6);
    expect(last.get('mid')!).toBeCloseTo(-30 * deg, 6);
    expect(last.get('output')!).toBeCloseTo(10 * deg, 6);
    // Dragging the output drives the input back through both stages.
    const back = dragAlong(scene, 'output', new Vector3(10, 0, 0), (k, g) => g.clone().sub(new Vector3(80, 0, 0)).applyAxisAngle(new Vector3(0, 0, 1), k * 0.5 * deg).add(new Vector3(80, 0, 0)), 10);
    expect(back.spins.at(-1)!.get('output')!).toBeCloseTo(5 * deg, 6);
    expect(back.spins.at(-1)!.get('input')!).toBeCloseTo(45 * deg, 6);
  });

  it('an internal pair turns the same way at the ratio', () => {
    const scene: Scene = {
      bodies: [
        body('plate', true, new Vector3(), [connector('ring', [0, 0, 0]), connector('pinion', [18, 0, 0])]),
        body('ring', false, new Vector3(), [connector('axis', [0, 0, 0])]),
        body('pinion', false, new Vector3(18, 0, 0), [connector('axis', [0, 0, 0])]),
      ],
      mates: [revolute('ring', ['plate', 'ring'], ['ring', 'axis']), revolute('pinion', ['plate', 'pinion'], ['pinion', 'axis'])],
      relations: [gear('ip', 'pinion', 'ring', 24 / 60)],
    };
    const run = dragAlong(scene, 'pinion', new Vector3(6, 0, 0), (k, g) => g.clone().sub(new Vector3(18, 0, 0)).applyAxisAngle(new Vector3(0, 0, 1), k * deg).add(new Vector3(18, 0, 0)), 25);
    expect(run.okay).toBe(25);
    expect(run.spins.at(-1)!.get('pinion')!).toBeCloseTo(25 * deg, 6);
    expect(run.spins.at(-1)!.get('ring')!).toBeCloseTo(10 * deg, 6);
  });

  it('a relation alongside a closure that the train satisfies stays exact (coaxial second bearing)', () => {
    const scene = gearPair();
    // A second revolute on g2, coaxial with its first: a closure every angle satisfies.
    scene.mates.push(revolute('m2b', ['plate', 'axle2b'], ['g2', 'bore2']));
    const run = turnG1(scene, 30, 1);
    expect(run.okay).toBe(30);
    expect(run.outs.every(o => o.failed.length === 0 && o.failedRelations.length === 0)).toBe(true);
    expect(run.spins.at(-1)!.get('g1')!).toBeCloseTo(30 * deg, 6);
    expect(run.spins.at(-1)!.get('g2')!).toBeCloseTo(60 * deg, 6);
  });

  it('a relation fighting a fastened closure falls back to the weighted compromise and reports the relation', () => {
    const scene = gearPair();
    scene.mates.push({
      mateId: 'hold', type: 'fastened',
      connectorA: { instanceId: 'plate', connectorId: 'axle2' }, connectorB: { instanceId: 'g2', connectorId: 'bore' },
      options: { flip: true },
    });
    const out = new Solver().solve({
      bodies: cloneBodies(scene.bodies), mates: scene.mates, relations: scene.relations,
      drivenJoint: { mateId: 'm1', value: 30 },
    });
    expect(out.failedRelations).toEqual(['m1~m2']);
    expect(out.contradictedRelations).toEqual([]);
    expect(out.result).toBe('inconsistent');
  });
});

describe('exact relations — randomized gear trains', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it('random consistent relation graphs over a row of gears hold exactly under a driver and a drag', () => {
    for (let trial = 0; trial < 40; trial++) {
      const rand = rng(1000 + trial);
      const n = 2 + Math.floor(rand() * 5);
      // Hidden spin rate per gear: every relation's ratio is the rates' quotient.
      const rate = Array.from({ length: n }, () => (rand() < 0.5 ? -1 : 1) * (0.25 + rand() * 3));
      const plate = body('plate', true, new Vector3(), Array.from({ length: n }, (_, i) => connector(`a${i}`, [40 * i, 0, 0])));
      const gears = Array.from({ length: n }, (_, i) => body(`g${i}`, false, new Vector3(40 * i, 0, 0), [connector('bore', [0, 0, 0])]));
      const mates = gears.map((_, i) => revolute(`m${i}`, ['plate', `a${i}`], [`g${i}`, 'bore']));
      const relations: RelationRecord[] = [];
      for (let i = 1; i < n; i++) {
        const a = Math.floor(rand() * i);
        const r = rate[i] / rate[a];
        relations.push(gear(`t${i}`, `m${a}`, `m${i}`, Math.abs(r), r < 0));
      }
      for (let c = 0; c < Math.floor(rand() * 3); c++) {
        const a = Math.floor(rand() * n);
        let b = Math.floor(rand() * n);
        if (b === a) b = (a + 1) % n;
        const r = rate[b] / rate[a];
        relations.push(gear(`c${c}`, `m${a}`, `m${b}`, Math.abs(r), r < 0));
      }
      const scene: Scene = { bodies: [plate, ...gears], mates, relations };
      // Driver: one gear to a random angle; every gear turns at its rate.
      const driven = Math.floor(rand() * n);
      const value = (rand() - 0.5) * 120;
      const bodies = cloneBodies(scene.bodies);
      const out = new Solver().solve({ bodies, mates, relations, drivenJoint: { mateId: `m${driven}`, value } });
      expect(out.result).toBe('okay');
      expect(out.dof).toBe(0);
      applyOut(bodies, out);
      const r = readouts(scene, bodies);
      const u = value / rate[driven];
      for (let i = 0; i < n; i++) {
        expect(angleGap(r.get(`m${i}`)! * deg, rate[i] * u * deg)).toBeLessThan(1e-8);
      }
      // Drag: one gear by its grab; every relation holds every frame.
      const dragged = Math.floor(rand() * n);
      const centre = new Vector3(40 * dragged, 0, 0);
      const run = dragAlong(scene, `g${dragged}`, new Vector3(10, 0, 0),
        (k, g) => g.clone().sub(centre).applyAxisAngle(new Vector3(0, 0, 1), k * 2 * deg).add(centre), 20);
      expect(run.okay).toBe(20);
      const last = run.spins.at(-1)!;
      const uu = last.get(`g${dragged}`)! / rate[dragged];
      expect(last.get(`g${dragged}`)!).toBeCloseTo(40 * deg, 6);
      for (let i = 0; i < n; i++) expect(angleGap(last.get(`g${i}`)!, rate[i] * uu)).toBeLessThan(1e-8);
    }
  });
});
