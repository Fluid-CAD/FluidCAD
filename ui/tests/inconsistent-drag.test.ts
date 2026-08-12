import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// An assembly with an UNENFORCEABLE mate (e.g. between two grounded
// bodies — the cnc-cad2 index.assembly.js shape) reports 'inconsistent'
// on every solve. Drags must still work: the failing closure is
// constant with respect to every joint variable, so it must neither
// freeze the analytic warm-start drag nor make the LM fight the user.

function flatConnector(connectorId: string, ox = 0, oy = 0, oz = 0): ConnectorState {
  return {
    connectorId,
    localOrigin: new Vector3(ox, oy, oz),
    localXDirection: new Vector3(1, 0, 0),
    localNormal: new Vector3(0, 0, 1),
  };
}

function body(
  instanceId: string,
  grounded: boolean,
  position: Vector3,
  connectors: ConnectorState[],
): BodyState {
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

// Miniature of the cnc-cad2 main assembly:
//   frameLeft (grounded) ←unsatisfiable fastened→ post (grounded)
//   post —fastened— beam —fastened— rail —SLIDER— carriage —fastened— plate
// Dragging the plate must slide the carriage cluster along the rail.
function buildAssembly(): { bodies: BodyState[]; mates: MateRecord[] } {
  const bodies = [
    body('frameLeft', true, new Vector3(0, 0, 0), [flatConnector('top')]),
    body('post', true, new Vector3(200, 0, 0), [flatConnector('base'), flatConnector('head', 0, 0, 50)]),
    body('beam', false, new Vector3(0, 0, 0), [flatConnector('mount'), flatConnector('railSeat', 30, 0)]),
    body('rail', false, new Vector3(0, 0, 0), [flatConnector('seat'), flatConnector('guide', 0, 10)]),
    body('carriage', false, new Vector3(0, 0, 0), [flatConnector('main'), flatConnector('hole', 5, 0)]),
    body('plate', false, new Vector3(0, 0, 0), [flatConnector('bottom')]),
  ];
  const mates = [
    // Unenforceable: both endpoints grounded, 200 mm apart.
    mateRecord('m-ground', 'fastened',
      { i: 'frameLeft', c: 'top' }, { i: 'post', c: 'base' }),
    mateRecord('m-beam', 'fastened',
      { i: 'post', c: 'head' }, { i: 'beam', c: 'mount' }),
    mateRecord('m-rail', 'fastened',
      { i: 'beam', c: 'railSeat' }, { i: 'rail', c: 'seat' }),
    mateRecord('m-slider', 'slider',
      { i: 'rail', c: 'guide' }, { i: 'carriage', c: 'main' }),
    mateRecord('m-plate', 'fastened',
      { i: 'carriage', c: 'hole' }, { i: 'plate', c: 'bottom' }),
  ];
  return { bodies, mates };
}

function connWorld(
  b: { position: Vector3; quaternion: Quaternion },
  conn: ConnectorState,
): Vector3 {
  return conn.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
}

describe('drags keep working while the assembly is inconsistent', () => {
  it('reports only the unenforceable mate and still slides the dragged cluster', () => {
    const { bodies, mates } = buildAssembly();
    const solver = new Solver();

    const settle = solver.solve({ bodies, mates });
    expect(settle.result).toBe('inconsistent');
    expect(settle.failed).toEqual(['m-ground']);

    // Rail axis is the guide connector's Z in world.
    const railSettled = settle.bodies.find(b => b.instanceId === 'rail')!;
    const railBody = bodies.find(b => b.instanceId === 'rail')!;
    const axis = railBody.connectors[1].localNormal.clone()
      .applyQuaternion(railSettled.quaternion).normalize();

    // Drag the PLATE (a fastened sibling of the slider follower) 20 mm
    // along the rail axis.
    const plateSettled = settle.bodies.find(b => b.instanceId === 'plate')!;
    const grabLocal = new Vector3(0, 0, 0);
    const grabWorld = grabLocal.clone()
      .applyQuaternion(plateSettled.quaternion).add(plateSettled.position);
    const cursor = grabWorld.clone().addScaledVector(axis, 20);

    const draggedBodies = settle.bodies.map(s => ({
      ...bodies.find(b => b.instanceId === s.instanceId)!,
      position: s.position.clone(),
      quaternion: s.quaternion.clone(),
    }));
    const out = solver.solve({
      bodies: draggedBodies,
      mates,
      draggedInstanceId: 'plate',
      draggedCursorWorld: cursor,
      draggedGrabLocal: grabLocal,
    });

    // Still inconsistent (the ground mate can never close), but the
    // drag went through: the plate moved 20 mm along the axis and the
    // slider stayed exact.
    expect(out.result).toBe('inconsistent');
    expect(out.failed).toEqual(['m-ground']);

    const plateOut = out.bodies.find(b => b.instanceId === 'plate')!;
    const grabAfter = grabLocal.clone()
      .applyQuaternion(plateOut.quaternion).add(plateOut.position);
    expect(grabAfter.distanceTo(cursor)).toBeLessThan(1e-6);

    // Slider still on-axis: carriage.main sits on the guide's Z line.
    const railOut = out.bodies.find(b => b.instanceId === 'rail')!;
    const carriageOut = out.bodies.find(b => b.instanceId === 'carriage')!;
    const guide = bodies.find(b => b.instanceId === 'rail')!.connectors[1];
    const main = bodies.find(b => b.instanceId === 'carriage')!.connectors[0];
    const diff = connWorld(carriageOut, main).sub(connWorld(railOut, guide));
    const perp = diff.clone().sub(axis.clone().multiplyScalar(diff.dot(axis)));
    expect(perp.length()).toBeLessThan(1e-6);
  });
});
