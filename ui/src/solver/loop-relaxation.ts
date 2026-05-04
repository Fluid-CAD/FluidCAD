// Loop / chain relaxation orchestrator.
//
// After the spanning-tree warm-start has placed every body, walk each
// connected component of the mate graph and run a Levenberg-Marquardt
// pass when LM has work to do — either:
//
//   (a) the component has a closure edge, OR
//   (b) the user is dragging a body inside the component AND the
//       component has at least one non-grounded body and one mate.
//
// (b) covers chains: e.g. `A grounded → revolute → B → revolute → C`
// where the user drags C. Without LM, the spanning-tree warm-start
// only rotates C around its parent's pivot — the upstream B never
// rotates because the existing drag-of-cluster logic propagates only
// through fastened mates. LM treats all non-grounded component bodies
// as variables and the drag as a soft residual, so the entire chain's
// joint angles cooperate to bring C's grab to the cursor (inverse
// kinematics).
//
// LM cost: per-mate residuals for every mate in the component
// (tree + closure) + an optional drag residual on the dragged body.
// Per-mate residuals enforce the kinematic relations; the drag
// residual is the soft cursor pin.

import { Vector3 } from 'three';
import type { Component } from './graph.js';
import { runLM } from './relaxation.js';
import {
  residualCylindrical,
  residualDrag,
  residualFastened,
  residualPlanar,
  residualRevolute,
  residualSlider,
} from './residuals.js';
import type { BodyState, ConnectorState, MateRecord } from './types.js';

export type LoopDragInfo = {
  draggedInstanceId?: string;
  draggedCursorWorld?: Vector3;
  draggedGrabLocal?: Vector3;
};

type LoopMate = {
  mate: MateRecord;
  parent: BodyState;
  child: BodyState;
  parentConn: ConnectorState;
  childConn: ConnectorState;
};

// Drag is a SOFT cursor pin; closure / mate residuals are hard. With
// equal weights, a 10 mm unreachable drag would produce drag-cost 100,
// while breaking a closure by 1 mm produces cost 1 per residual scalar
// (×5 for revolute = 5). LM would prefer the cheaper option (break
// closure). Weighting drag ×0.5 keeps closure dominant when the cursor
// is unreachable while still letting LM reach reachable cursors. This
// matters mostly for closures (master plan §3.4); for chains the drag
// is generally reachable and weight has little effect.
const DRAG_WEIGHT = 0.5;

/**
 * For every component that needs LM (closure or drag-in-chain), run a
 * relaxation pass. Mutates body poses in-place when LM converges (or
 * settles on a low-residual config); leaves them at warm-start poses
 * on outright failure.
 */
export function applyLoopRelaxations(
  bodies: BodyState[],
  components: Component[],
  drag: LoopDragInfo = {},
): void {
  if (components.length === 0) return;
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  for (const component of components) {
    if (!shouldRelax(component, drag)) continue;
    relaxComponent(component, bodyById, drag);
  }
}

function shouldRelax(component: Component, drag: LoopDragInfo): boolean {
  if (component.closureEdges.length > 0) return true;
  if (drag.draggedInstanceId === undefined) return false;
  const draggedInComponent = component.bodies
    .some(b => b.instanceId === drag.draggedInstanceId);
  if (!draggedInComponent) return false;
  const hasFreedom = component.bodies.some(b => !b.grounded);
  const hasMates = component.treeEdges.length > 0
    || component.closureEdges.length > 0;
  return hasFreedom && hasMates;
}

function relaxComponent(
  component: Component,
  bodyById: Map<string, BodyState>,
  drag: LoopDragInfo,
): void {
  const componentMates = collectComponentMates(component, bodyById);
  if (componentMates === null) return; // unsupported mate type
  if (componentMates.length === 0) return;

  // Variables: 7 floats per non-grounded body in this component.
  // Includes both loop bodies and chain bodies — the LM doesn't need
  // to distinguish, and including all of them lets a chain's drag
  // propagate up through revolute/slider/etc. links to the root.
  const variableBodies = component.bodies.filter(b => !b.grounded);
  if (variableBodies.length === 0) return;

  // Project the cursor onto the dragged body's kinematic plane. The
  // controller sets its drag plane perpendicular to the camera, so an
  // angled view gives the cursor a 3D motion the planar mechanism
  // can't satisfy — LM tries to chase an unreachable Z component and
  // fights itself frame-to-frame. Projecting onto the plane
  // perpendicular to the dragged body's first-connector world normal
  // (typically the mate's rotation axis) drops that unreachable
  // component before LM ever sees it.
  const projectedDrag = projectDragOntoBodyPlane(drag, bodyById);

  const n = variableBodies.length * 7;
  const x0 = new Float64Array(n);
  packBodies(variableBodies, x0);

  // Save originals so we can restore on outright LM failure.
  const originals = variableBodies.map(b => ({
    pos: b.position.clone(),
    quat: b.quaternion.clone(),
  }));

  const evaluate = (x: Float64Array): Float64Array => {
    unpackBodies(variableBodies, x);
    return computeResiduals(componentMates, variableBodies, projectedDrag);
  };

  const normalize = (x: Float64Array): void => {
    for (let i = 0; i < variableBodies.length; i++) {
      const off = i * 7 + 3;
      const qx = x[off], qy = x[off + 1], qz = x[off + 2], qw = x[off + 3];
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      if (len > 1e-12) {
        x[off] = qx / len;
        x[off + 1] = qy / len;
        x[off + 2] = qz / len;
        x[off + 3] = qw / len;
      } else {
        x[off] = 0; x[off + 1] = 0; x[off + 2] = 0; x[off + 3] = 1;
      }
    }
  };

  const result = runLM(x0, evaluate, normalize);

  // Always accept finite LM output. `runLM` only commits steps that
  // strictly reduce the squared residual, so the final state is
  // monotonically improved over the initial state. Restoring on
  // "didn't reach a tight tolerance" caused jitter during drag: any
  // frame that landed slightly above the threshold would snap back to
  // the warm-start pose, then LM would re-converge the next frame —
  // visible fighting.
  if (Number.isFinite(result.residualNorm)) {
    unpackBodies(variableBodies, result.x);
  } else {
    for (let i = 0; i < variableBodies.length; i++) {
      variableBodies[i].position.copy(originals[i].pos);
      variableBodies[i].quaternion.copy(originals[i].quat);
    }
  }
}

/**
 * Drop the component of `cursor - grab` parallel to the dragged
 * body's primary kinematic axis (its first connector's world normal).
 * For planar mechanisms with all-Z connectors, this strips the Z
 * component of the drag delta — making the drag target reachable
 * regardless of camera angle.
 *
 * Returns the original drag info unchanged when there's no drag, no
 * dragged body, or no projection axis to apply.
 */
function projectDragOntoBodyPlane(
  drag: LoopDragInfo,
  bodyById: Map<string, BodyState>,
): LoopDragInfo {
  if (
    drag.draggedInstanceId === undefined
    || drag.draggedCursorWorld === undefined
    || drag.draggedGrabLocal === undefined
  ) {
    return drag;
  }
  const dragged = bodyById.get(drag.draggedInstanceId);
  if (!dragged || dragged.connectors.length === 0) return drag;

  const axis = dragged.connectors[0].localNormal.clone()
    .applyQuaternion(dragged.quaternion).normalize();
  if (axis.lengthSq() < 1e-12) return drag;

  const grabWorld = drag.draggedGrabLocal.clone()
    .applyQuaternion(dragged.quaternion).add(dragged.position);
  const offset = drag.draggedCursorWorld.clone().sub(grabWorld);
  const along = offset.dot(axis);
  if (Math.abs(along) < 1e-9) return drag;

  const projected = drag.draggedCursorWorld.clone()
    .addScaledVector(axis, -along);
  return { ...drag, draggedCursorWorld: projected };
}

/**
 * Resolve every mate in the component (tree + closure) into a uniform
 * `LoopMate` shape (parent/child + connector refs). Tree edges keep
 * their parent→child direction; closure mates use connectorA →
 * connectorB. Returns `null` if any mate is of a type that doesn't
 * have a residual function yet — the caller treats that as "skip this
 * component" so unsupported types don't silently emit garbage.
 */
function collectComponentMates(
  component: Component,
  bodyById: Map<string, BodyState>,
): LoopMate[] | null {
  const out: LoopMate[] = [];
  for (const edge of component.treeEdges) {
    if (!hasResidual(edge.mate.type)) return null;
    out.push({
      mate: edge.mate,
      parent: edge.parent,
      child: edge.child,
      parentConn: edge.parentConn,
      childConn: edge.childConn,
    });
  }
  for (const closure of component.closureEdges) {
    if (!hasResidual(closure.type)) return null;
    const a = bodyById.get(closure.connectorA.instanceId);
    const b = bodyById.get(closure.connectorB.instanceId);
    if (!a || !b) continue;
    const aConn = a.connectors.find(c => c.connectorId === closure.connectorA.connectorId);
    const bConn = b.connectors.find(c => c.connectorId === closure.connectorB.connectorId);
    if (!aConn || !bConn) continue;
    out.push({
      mate: closure,
      parent: a,
      child: b,
      parentConn: aConn,
      childConn: bConn,
    });
  }
  return out;
}

function hasResidual(type: MateRecord['type']): boolean {
  switch (type) {
    case 'fastened':
    case 'revolute':
    case 'slider':
    case 'cylindrical':
    case 'planar':
      return true;
    default:
      return false;
  }
}

function computeResiduals(
  componentMates: LoopMate[],
  variableBodies: BodyState[],
  drag: LoopDragInfo,
): Float64Array {
  let total = 0;
  for (const lm of componentMates) total += residualDimension(lm.mate.type);
  const dragApplies =
    drag.draggedInstanceId !== undefined
    && drag.draggedCursorWorld !== undefined
    && drag.draggedGrabLocal !== undefined
    && variableBodies.some(b => b.instanceId === drag.draggedInstanceId);
  if (dragApplies) total += 3;

  const out = new Float64Array(total);
  let i = 0;
  for (const lm of componentMates) {
    const r = matchResidual(lm);
    for (const v of r) {
      out[i++] = v;
    }
  }
  if (dragApplies) {
    const dragged = variableBodies.find(b => b.instanceId === drag.draggedInstanceId)!;
    const r = residualDrag(dragged, drag.draggedGrabLocal!, drag.draggedCursorWorld!);
    for (const v of r) {
      out[i++] = v * DRAG_WEIGHT;
    }
  }
  return out;
}

function residualDimension(type: MateRecord['type']): number {
  switch (type) {
    case 'fastened': return 6;
    case 'revolute': return 5;
    case 'slider': return 5;
    case 'cylindrical': return 4;
    case 'planar': return 3;
    default: return 0;
  }
}

function matchResidual(lm: LoopMate): number[] {
  const opts = lm.mate.options ?? {};
  switch (lm.mate.type) {
    case 'fastened':
      return residualFastened(lm.parent, lm.child, lm.parentConn, lm.childConn, opts);
    case 'revolute':
      return residualRevolute(lm.parent, lm.child, lm.parentConn, lm.childConn, opts);
    case 'slider':
      return residualSlider(lm.parent, lm.child, lm.parentConn, lm.childConn, opts);
    case 'cylindrical':
      return residualCylindrical(lm.parent, lm.child, lm.parentConn, lm.childConn, opts);
    case 'planar':
      return residualPlanar(lm.parent, lm.child, lm.parentConn, lm.childConn, opts);
    default:
      return [];
  }
}

function packBodies(variableBodies: BodyState[], x: Float64Array): void {
  for (let i = 0; i < variableBodies.length; i++) {
    const b = variableBodies[i];
    const off = i * 7;
    x[off] = b.position.x;
    x[off + 1] = b.position.y;
    x[off + 2] = b.position.z;
    x[off + 3] = b.quaternion.x;
    x[off + 4] = b.quaternion.y;
    x[off + 5] = b.quaternion.z;
    x[off + 6] = b.quaternion.w;
  }
}

function unpackBodies(variableBodies: BodyState[], x: Float64Array): void {
  for (let i = 0; i < variableBodies.length; i++) {
    const b = variableBodies[i];
    const off = i * 7;
    b.position.set(x[off], x[off + 1], x[off + 2]);
    // Three.js's applyQuaternion assumes unit-norm input; LM's FD step
    // perturbs quat components individually, which breaks normalization.
    // Normalize on every unpack so residual functions always see a unit
    // quaternion even during Jacobian evaluation.
    b.quaternion.set(x[off + 3], x[off + 4], x[off + 5], x[off + 6]).normalize();
  }
}
