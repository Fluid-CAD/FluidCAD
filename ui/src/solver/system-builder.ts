// Translates a SolverInput into a populated solvespace System.
//
// Layout (per body):
//   - 3 origin params (px, py, pz)
//   - 4 quaternion params (qw, qx, qy, qz)
//   - POINT_IN_3D entity referencing the origin params
//   - NORMAL_IN_3D entity referencing the quaternion params
//   - WORKPLANE entity referencing point + normal
//
// Per connector on body i (only when local Z ≈ 0):
//   - POINT_IN_2D (u, v) at the connector origin, in workplane i.
//   - POINT_IN_2D (u', v') one unit along the connector's X axis, in workplane i.
//   - LINE_SEGMENT between them — the connector's X axis in body workplane.
//
// The body's own NORMAL_IN_3D entity (which rotates with the body) is what
// mate compilers use for the connector's Z direction; we don't materialise a
// per-connector world-normal entity because it would need to be a function
// of the body's params, which slvs can't express.
//
// Group assignment:
//   - Grounded body params → group 1 (fixed by the solver).
//   - Ungrounded body params → group 2 (active group; what Slvs_Solve solves).
//   - Connector-local constants (u, v, connector quat) → group 1 always.
//
// Phase 05 adds no constraints to the system. Phase 06+ will reference
// connector entity handles by (instanceId, connectorId) via BodyHandles.

import { Quaternion, Vector3 } from 'three';
import { ConnectorState, SolverInput } from './types.js';
import type { SolveSpaceApi } from './solvespace-loader.js';
import { compileMate, type CompileCtx } from './mate-compiler.js';

export const GROUP_GROUND = 1;
export const GROUP_ACTIVE = 2;

export type ParamHandle = number;
export type EntityHandle = number;

export type ConnectorHandles = {
  connectorId: string;
  /** Workplane-local 2D point referencing (u, v) params. */
  point: EntityHandle;
  /**
   * LINE_SEGMENT in the body workplane from the connector origin one unit
   * along the connector's X axis. Used by ANGLE constraints (e.g. fastened's
   * rotate option) to lock relative roll between two connectors.
   */
  xAxisLine: EntityHandle;
  /** Param handles for the connector's u, v in the body's workplane. */
  uvParams: [ParamHandle, ParamHandle];
  /** Original local-frame data, kept around for mate compilers that need
   *  to add auxiliary points (e.g. offsets) in the body's workplane. */
  localOrigin: { x: number; y: number; z: number };
  localXDirection: { x: number; y: number; z: number };
  localNormal: { x: number; y: number; z: number };
};

export type BodyHandles = {
  instanceId: string;
  /** Param handles for px, py, pz. */
  originParams: [ParamHandle, ParamHandle, ParamHandle];
  /** Param handles for qw, qx, qy, qz. */
  quatParams: [ParamHandle, ParamHandle, ParamHandle, ParamHandle];
  point: EntityHandle;
  normal: EntityHandle;
  workplane: EntityHandle;
  grounded: boolean;
  connectors: ConnectorHandles[];
};

export type BuiltSystem = {
  sys: any;
  bodies: BodyHandles[];
  /** Sum of group-2 free params minus the implicit unit-norm constraint count.
   *  Used as a hint; the real DOF comes back from `Slvs_Solve`. */
  expectedFreeParams: number;
  /** Maps each constraint handle to the mateId that produced it. Lets the
   *  solver translate libslvs' `failed[]` back into mate ids for the joints
   *  panel and DOF footer. */
  constraintToMate: Map<number, string>;
};

const Z_EPS = 1e-9;

/**
 * Walks the input and returns a fresh, fully-populated System ready to solve.
 * The handle tables let the caller (drag setup, mate compilation) reach back
 * into specific params/entities without re-walking the input.
 *
 * `slvsEmitMates` is the set of mate ids whose compilers should emit real
 * slvs constraints (the slvs-solvable loop path; see slvs-loop.ts). Empty
 * by default — every mate compiles to `[]`, matching the JS-side tree
 * pattern.
 */
export function buildSystem(
  api: SolveSpaceApi,
  input: SolverInput,
  slvsEmitMates: Set<string> = new Set(),
): BuiltSystem {
  const sys = new api.System(api.module);
  const bodies: BodyHandles[] = [];
  let nextH = 1;
  const newH = () => nextH++;

  let expectedFreeParams = 0;

  for (const body of input.bodies) {
    // grounded → all 7 params frozen.
    // lockPosition (on a non-grounded body) → origin params frozen.
    // lockOrientation (on a non-grounded body) → quat params frozen.
    // Both flags together = effectively "follower" (fully determined by a
    // driver body); the solver treats this body as a known.
    const originGroup = body.grounded || body.lockPosition
      ? GROUP_GROUND
      : GROUP_ACTIVE;
    const quatGroup = body.grounded || body.lockOrientation
      ? GROUP_GROUND
      : GROUP_ACTIVE;
    if (!body.grounded) {
      if (!body.lockPosition) {
        expectedFreeParams += 3;
      }
      if (!body.lockOrientation) {
        // Quat: 4 params - 1 unit-norm = 3 free.
        expectedFreeParams += 3;
      }
    }

    const px = sys.addParam(newH(), originGroup, body.position.x);
    const py = sys.addParam(newH(), originGroup, body.position.y);
    const pz = sys.addParam(newH(), originGroup, body.position.z);
    const point = sys.addPoint3d(newH(), originGroup, px, py, pz);

    // Three.js Quaternion is (x, y, z, w); libslvs is (w, x, y, z).
    const qw = sys.addParam(newH(), quatGroup, body.quaternion.w);
    const qx = sys.addParam(newH(), quatGroup, body.quaternion.x);
    const qy = sys.addParam(newH(), quatGroup, body.quaternion.y);
    const qz = sys.addParam(newH(), quatGroup, body.quaternion.z);
    const normal = sys.addNormal3d(newH(), quatGroup, qw, qx, qy, qz);

    const workplane = sys.addWorkplane(newH(), originGroup, point, normal);

    const connectorHandles: ConnectorHandles[] = [];
    for (const c of body.connectors) {
      const handles = addConnectorEntities(sys, api, workplane, c, newH);
      connectorHandles.push(handles);
    }

    bodies.push({
      instanceId: body.instanceId,
      originParams: [px, py, pz],
      quatParams: [qw, qx, qy, qz],
      point,
      normal,
      workplane,
      grounded: body.grounded,
      connectors: connectorHandles,
    });
  }

  const constraintToMate = new Map<number, string>();
  if (input.mates.length > 0) {
    const ctx: CompileCtx = {
      api,
      sys,
      bodies,
      newH,
      constraintToMate,
      slvsEmitMates,
    };
    for (const mate of input.mates) {
      compileMate(ctx, mate);
    }
  }

  return { sys, bodies, expectedFreeParams, constraintToMate };
}

function addConnectorEntities(
  sys: any,
  _api: SolveSpaceApi,
  workplane: EntityHandle,
  c: ConnectorState,
  newH: () => number,
): ConnectorHandles {
  // Connector params live in group 1 — they're constants relative to the
  // body, not solver unknowns. The body's own params drive how the connector
  // moves in world space (via the workplane reference).
  if (Math.abs(c.localOrigin.z) > Z_EPS) {
    // Phase 06 limitation: connectors with non-zero local Z are projected
    // onto the body's workplane (the z component is dropped). Connectors
    // authored on the part's xy plane — the common case — are exact.
  }
  const u = sys.addParam(newH(), GROUP_GROUND, c.localOrigin.x);
  const v = sys.addParam(newH(), GROUP_GROUND, c.localOrigin.y);
  const point = sys.addPoint2d(newH(), GROUP_GROUND, workplane, u, v);

  // X-axis tip point + line. The tip sits one unit along the connector's
  // X axis in the body's workplane. ANGLE between two such lines (one per
  // connector) is what mate compilers use to lock relative roll.
  const ux = sys.addParam(newH(), GROUP_GROUND, c.localOrigin.x + c.localXDirection.x);
  const vx = sys.addParam(newH(), GROUP_GROUND, c.localOrigin.y + c.localXDirection.y);
  const xTip = sys.addPoint2d(newH(), GROUP_GROUND, workplane, ux, vx);
  const xAxisLine = sys.addLineSegment(newH(), GROUP_GROUND, workplane, point, xTip);

  return {
    connectorId: c.connectorId,
    point,
    xAxisLine,
    uvParams: [u, v],
    localOrigin: { x: c.localOrigin.x, y: c.localOrigin.y, z: c.localOrigin.z },
    localXDirection: {
      x: c.localXDirection.x, y: c.localXDirection.y, z: c.localXDirection.z,
    },
    localNormal: {
      x: c.localNormal.x, y: c.localNormal.y, z: c.localNormal.z,
    },
  };
}

/**
 * Read body poses back from a solved system into BodyState.position/quaternion
 * shape. Returns the same {instanceId, position, quaternion} list, in input
 * order, so callers can map outputs by index without re-checking ids.
 */
export function readBackPoses(
  built: BuiltSystem,
): { instanceId: string; position: Vector3; quaternion: Quaternion }[] {
  const sys = built.sys;
  return built.bodies.map(handles => {
    const px = sys.getParam(handles.originParams[0]);
    const py = sys.getParam(handles.originParams[1]);
    const pz = sys.getParam(handles.originParams[2]);
    const qw = sys.getParam(handles.quatParams[0]);
    const qx = sys.getParam(handles.quatParams[1]);
    const qy = sys.getParam(handles.quatParams[2]);
    const qz = sys.getParam(handles.quatParams[3]);
    // Three.js Quaternion ctor takes (x, y, z, w).
    const q = new Quaternion(qx, qy, qz, qw);
    // Defensive normalize — solvespace generally keeps unit norm but tiny
    // numerical drift can creep in. Three.js multiplies use the bare
    // values, so a sub-unit quaternion would bleed scale into the next solve.
    q.normalize();
    return {
      instanceId: handles.instanceId,
      position: new Vector3(px, py, pz),
      quaternion: q,
    };
  });
}
