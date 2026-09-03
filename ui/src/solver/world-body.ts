// The synthetic world body every assembly-connector mate side resolves
// against.
//
// `mate('revolute', hinge, inst.connectors.shaft)` — with `hinge` a
// `connector('hinge', [x, y, z])` declared at assembly level — serializes a
// `frameA/frameB: { connectorId }` side. The solver stays frame-unaware: the
// controller converts each frame side into an ordinary connector ref on a
// grounded body at the world identity pose (`WORLD_BODY_ID`), whose
// connectors are the assembly's own connectors at their built frames.
// Grounded bodies are always BFS roots, so the assembly side is always the
// mate's driver — mate options (`.offset()`, `.rotate()`) read in that
// connector's frame.

import { Quaternion, Vector3 } from 'three';
import type { BodyState, ConnectorState, MateRecord } from './types.js';

/** Never collides with `inst-N` / occurrence-path instance ids. */
export const WORLD_BODY_ID = '__world__';

/** The frame one assembly connector carries, as the assembly payload lists it. */
export type WorldConnectorFrame = {
  connectorId: string;
  origin: { x: number; y: number; z: number };
  xDirection: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
};

/** A fresh world body (grounded, identity pose) carrying the given connectors. */
export function makeWorldBody(connectors: ReadonlyArray<WorldConnectorFrame>): BodyState {
  const states: ConnectorState[] = connectors.map(c => ({
    connectorId: c.connectorId,
    localOrigin: new Vector3(c.origin.x, c.origin.y, c.origin.z),
    localXDirection: new Vector3(c.xDirection.x, c.xDirection.y, c.xDirection.z),
    localNormal: new Vector3(c.normal.x, c.normal.y, c.normal.z),
  }));
  return {
    instanceId: WORLD_BODY_ID,
    position: new Vector3(0, 0, 0),
    quaternion: new Quaternion(0, 0, 0, 1),
    grounded: true,
    connectors: states,
  };
}

/** The connector ref a serialized frame side becomes on the world body. */
export function worldConnectorRef(side: { connectorId: string }): { instanceId: string; connectorId: string } {
  return { instanceId: WORLD_BODY_ID, connectorId: side.connectorId };
}

/** Whether any mate in the set references the world body. */
export function matesReferenceWorld(mates: MateRecord[]): boolean {
  return mates.some(m =>
    m.connectorA?.instanceId === WORLD_BODY_ID || m.connectorB?.instanceId === WORLD_BODY_ID);
}

/** True when a mate side's instance id is the synthetic world body. */
export function isWorldBodyId(instanceId: string | undefined): boolean {
  return instanceId === WORLD_BODY_ID;
}
