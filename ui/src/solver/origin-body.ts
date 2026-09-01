// The synthetic world body an origin-frame mate side resolves against.
//
// `mate('revolute', origin(), inst.connectors.shaft)` serializes a
// `frameA/frameB: { axis }` side. The solver stays frame-unaware: the
// controller converts each frame side into an ordinary connector ref on a
// grounded body at the world identity pose (`ORIGIN_BODY_ID`), whose three
// connectors are the per-axis frames below. Grounded bodies are always BFS
// roots, so the origin side is always the mate's driver — mate options
// (`.offset()`, `.rotate()`) read in world coordinates.

import { Quaternion, Vector3 } from 'three';
import type { BodyState, ConnectorState, MateRecord } from './types.js';

export type OriginAxis = 'x' | 'y' | 'z';

/** Never collides with `inst-N` / occurrence-path instance ids. */
export const ORIGIN_BODY_ID = '__origin__';

export const ORIGIN_CONNECTOR_ID: Record<OriginAxis, string> = {
  z: '__origin__:z',
  x: '__origin__:x',
  y: '__origin__:y',
};

/**
 * Per-axis frames — Z along the named world axis, X per the kernel's
 * `Plane.uprightXDirection` rule (mirrors ORIGIN_AXIS_FRAMES in
 * lib/features/origin-frame.ts; keep the two tables in sync).
 */
const ORIGIN_AXIS_FRAMES: Record<OriginAxis, { z: [number, number, number]; x: [number, number, number] }> = {
  z: { z: [0, 0, 1], x: [1, 0, 0] },
  x: { z: [1, 0, 0], x: [0, 1, 0] },
  y: { z: [0, 1, 0], x: [-1, 0, 0] },
};

function originConnectorStates(): ConnectorState[] {
  return (Object.keys(ORIGIN_AXIS_FRAMES) as OriginAxis[]).map((axis) => {
    const frame = ORIGIN_AXIS_FRAMES[axis];
    return {
      connectorId: ORIGIN_CONNECTOR_ID[axis],
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(...frame.x),
      localNormal: new Vector3(...frame.z),
    };
  });
}

/** A fresh world body (grounded, identity pose, one connector per axis). */
export function makeOriginBody(): BodyState {
  return {
    instanceId: ORIGIN_BODY_ID,
    position: new Vector3(0, 0, 0),
    quaternion: new Quaternion(0, 0, 0, 1),
    grounded: true,
    connectors: originConnectorStates(),
  };
}

/** The connector ref a serialized frame side becomes on the world body. */
export function originConnectorRef(side: { axis: OriginAxis }): { instanceId: string; connectorId: string } {
  return { instanceId: ORIGIN_BODY_ID, connectorId: ORIGIN_CONNECTOR_ID[side.axis] };
}

/** Whether any mate in the set references the world body. */
export function matesReferenceOrigin(mates: MateRecord[]): boolean {
  return mates.some(m =>
    m.connectorA?.instanceId === ORIGIN_BODY_ID || m.connectorB?.instanceId === ORIGIN_BODY_ID);
}

/** True when a mate side's instance id is the synthetic world body. */
export function isOriginBodyId(instanceId: string | undefined): boolean {
  return instanceId === ORIGIN_BODY_ID;
}
