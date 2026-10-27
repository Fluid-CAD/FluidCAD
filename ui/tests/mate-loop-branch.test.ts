import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, type BodyState, type ConnectorState, type MateRecord, type SolverInput } from '../src/solver';

// A body on a closed loop dragged past the mechanism's reach must stay on
// the branch it is on. The warm-start used to swing the dragged body about
// its tree joint to face the cursor — however far — and the loop
// relaxation then closed the loop from there, on the OTHER branch when
// the cursor was out of reach (a toggle clamp's cam link dragged past its
// stroke folded both cams back over the toggle, slide included). Loop
// bodies now get no analytic drag delta; the LM's drag rows move them
// from the previous configuration, which is local.

function flatConnector(connectorId: string, ox = 0, oy = 0): ConnectorState {
  return {
    connectorId,
    localOrigin: new Vector3(ox, oy, 0),
    localXDirection: new Vector3(1, 0, 0),
    localNormal: new Vector3(0, 0, 1),
  };
}

function body(instanceId: string, grounded: boolean, connectors: ConnectorState[], position = new Vector3()): BodyState {
  return { instanceId, position, quaternion: new Quaternion(), grounded, connectors };
}

function mateRecord(
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

// Slider-crank: ground G (pivot at origin, slide axis = world X), crank C
// (20 mm), coupler L (50 mm), piston P. On the working branch the piston
// sits at x = 20 cos θ + √(50² − (20 sin θ)²) ∈ [30, 70]; the folded
// branch has it at 20 cos θ − √(…), on the far side of the crank pin.
function sliderCrank(): { bodies: BodyState[]; mates: MateRecord[] } {
  const axis = (id: string): ConnectorState => ({
    ...flatConnector(id), localNormal: new Vector3(1, 0, 0), localXDirection: new Vector3(0, 1, 0),
  });
  return {
    bodies: [
      body('G', true, [flatConnector('pivot'), axis('slide')]),
      body('C', false, [flatConnector('root'), flatConnector('tip', 20, 0)]),
      body('L', false, [flatConnector('near'), flatConnector('far', 50, 0)], new Vector3(20, 0, 0)),
      body('P', false, [axis('slide'), flatConnector('pin')], new Vector3(70, 0, 0)),
    ],
    mates: [
      mateRecord('crank', 'revolute', { i: 'G', c: 'pivot' }, { i: 'C', c: 'root' }),
      mateRecord('elbow', 'revolute', { i: 'C', c: 'tip' }, { i: 'L', c: 'near' }),
      mateRecord('piston', 'slider', { i: 'G', c: 'slide' }, { i: 'P', c: 'slide' }),
      mateRecord('wrist', 'revolute', { i: 'L', c: 'far' }, { i: 'P', c: 'pin' }),
    ],
  };
}

function feedForward(bodies: BodyState[], out: ReturnType<Solver['solve']>): BodyState[] {
  return bodies.map(b => {
    const s = out.bodies.find(o => o.instanceId === b.instanceId)!;
    return { ...b, position: s.position.clone(), quaternion: s.quaternion.clone() };
  });
}

describe('dragging a loop body keeps the mechanism on its branch', () => {
  it('coupler dragged far past the stroke parks at the stroke end instead of folding', () => {
    const solver = new Solver();
    let { bodies } = sliderCrank();
    const { mates } = sliderCrank();
    const rest = solver.solve({ bodies, mates });
    expect(rest.result).toBe('okay');
    bodies = feedForward(bodies, rest);
    // Grab the coupler's midpoint (local (25, 0, 0)) and pull it along +X
    // in 6 mm steps to x = 110 — far beyond the piston's 70 mm maximum.
    const grab = new Vector3(25, 0, 0);
    for (let x = 51; x <= 110; x += 6) {
      const input: SolverInput = {
        bodies, mates,
        draggedInstanceId: 'L',
        draggedGrabLocal: grab,
        draggedCursorWorld: new Vector3(x, 0, 0),
      };
      const out = solver.solve(input);
      expect(out.result, `cursor x=${x}`).toBe('okay');
      const C = out.bodies.find(b => b.instanceId === 'C')!;
      const P = out.bodies.find(b => b.instanceId === 'P')!;
      const tip = new Vector3(20, 0, 0).applyQuaternion(C.quaternion).add(C.position);
      // Working branch: the piston pin is beyond the crank tip along +X.
      expect(P.position.x, `cursor x=${x}`).toBeGreaterThan(tip.x);
      expect(P.position.x, `cursor x=${x}`).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(P.position.x, `cursor x=${x}`).toBeLessThanOrEqual(70 + 1e-6);
      bodies = feedForward(bodies, out);
    }
    // Out of reach: the mechanism sits at the end of its stroke.
    const P = bodies.find(b => b.instanceId === 'P')!;
    expect(P.position.x).toBeCloseTo(70, 1);
  });

  it('coupler dragged within reach still follows the cursor', () => {
    const solver = new Solver();
    let { bodies } = sliderCrank();
    const { mates } = sliderCrank();
    bodies = feedForward(bodies, solver.solve({ bodies, mates }));
    // The coupler midpoint's locus: mid(θ) = (10 cos θ + x_P(θ)/2, 10 sin θ)
    // with x_P(θ) = 20 cos θ + √(50² − (20 sin θ)²). Walk the cursor along
    // it from θ = 0 to θ = 60° in five frames; with no analytic delta the
    // LM's drag rows must still bring the grab onto the cursor.
    const mid = (deg: number): Vector3 => {
      const t = (deg * Math.PI) / 180;
      const xP = 20 * Math.cos(t) + Math.sqrt(50 * 50 - (20 * Math.sin(t)) ** 2);
      return new Vector3(10 * Math.cos(t) + xP / 2, 10 * Math.sin(t), 0);
    };
    const grab = new Vector3(25, 0, 0);
    let out = solver.solve({ bodies, mates });
    for (const deg of [12, 24, 36, 48, 60]) {
      const input: SolverInput = {
        bodies, mates,
        draggedInstanceId: 'L',
        draggedGrabLocal: grab,
        draggedCursorWorld: mid(deg),
      };
      out = solver.solve(input);
      expect(out.result, `θ=${deg}`).toBe('okay');
      bodies = feedForward(bodies, out);
    }
    const L = out.bodies.find(b => b.instanceId === 'L')!;
    const grabWorld = grab.clone().applyQuaternion(L.quaternion).add(L.position);
    expect(grabWorld.distanceTo(mid(60))).toBeLessThan(0.05);
  });
});
