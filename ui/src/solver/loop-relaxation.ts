// Loop relaxation orchestrator.
//
// After the spanning-tree warm-start has placed every body, walk each
// component with closure edges and run a Levenberg-Marquardt pass over
// the loop bodies' poses. The LM cost stacks per-mate residuals
// (closure mates plus tree-edge mates that touch a loop body) plus an
// optional drag residual when the user is dragging a body in this
// loop.
//
// Stage 2 ships a revolute-only path: any loop with a mate whose type
// has no residual function yet is skipped silently. Stages 3+ add the
// remaining mate-type residuals.

import type { Vector3 } from 'three';
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

const DRAG_WEIGHT = 100;

/**
 * For every component with at least one closure edge, run an LM
 * relaxation over the loop bodies. Mutates the body poses in-place
 * when LM converges (or settles on a low-residual config); leaves
 * them unchanged on outright failure.
 */
export function applyLoopRelaxations(
  bodies: BodyState[],
  components: Component[],
  drag: LoopDragInfo = {},
): void {
  if (components.length === 0) return;
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  for (const component of components) {
    if (component.closureEdges.length === 0) continue;
    relaxComponent(component, bodyById, drag);
  }
}

function relaxComponent(
  component: Component,
  bodyById: Map<string, BodyState>,
  drag: LoopDragInfo,
): void {
  const loopMates = collectLoopMates(component, bodyById);
  if (loopMates === null) return; // unsupported mate type in this loop
  if (loopMates.length === 0) return;

  // Variables: 7 floats per non-grounded loop body. Grounded bodies on
  // a loop stay constant (they're referenced by residuals via the
  // shared BodyState refs but their pose never changes).
  const loopBodyIds = [...component.loopBodies];
  const loopBodies = loopBodyIds
    .map(id => bodyById.get(id))
    .filter((b): b is BodyState => b !== undefined && !b.grounded);
  if (loopBodies.length === 0) return;

  const n = loopBodies.length * 7;
  const x0 = new Float64Array(n);
  packBodies(loopBodies, x0);

  // Save originals so we can restore on outright LM failure.
  const originals = loopBodies.map(b => ({
    pos: b.position.clone(),
    quat: b.quaternion.clone(),
  }));

  const evaluate = (x: Float64Array): Float64Array => {
    unpackBodies(loopBodies, x);
    return computeResiduals(loopMates, loopBodies, drag);
  };

  const normalize = (x: Float64Array): void => {
    for (let i = 0; i < loopBodies.length; i++) {
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

  // Accept the LM output if it converged OR if it landed on a
  // configuration noticeably better than where we started. Otherwise
  // restore the warm-start poses so a failed LM doesn't visibly
  // disrupt the assembly.
  const acceptable = result.converged || result.residualNorm < 1e-2;
  if (acceptable) {
    unpackBodies(loopBodies, result.x);
  } else {
    for (let i = 0; i < loopBodies.length; i++) {
      loopBodies[i].position.copy(originals[i].pos);
      loopBodies[i].quaternion.copy(originals[i].quat);
    }
  }
}

/**
 * Resolve every mate that touches at least one loop body into a
 * uniform `LoopMate` shape (parent/child + connector refs). Tree edges
 * keep their parent→child direction; closure mates use connectorA →
 * connectorB. Returns `null` if any loop-touching mate is of a type
 * that doesn't have a residual function yet — the caller treats that
 * as "skip this loop" so unsupported types don't silently emit garbage.
 */
function collectLoopMates(
  component: Component,
  bodyById: Map<string, BodyState>,
): LoopMate[] | null {
  const out: LoopMate[] = [];
  const touchesLoop = (mate: MateRecord): boolean =>
    component.loopBodies.has(mate.connectorA.instanceId)
    || component.loopBodies.has(mate.connectorB.instanceId);

  for (const edge of component.treeEdges) {
    if (!touchesLoop(edge.mate)) continue;
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
    // 'parallel' and 'pin-slot' arrive in phases 11/12.
    default:
      return false;
  }
}

function computeResiduals(
  loopMates: LoopMate[],
  loopBodies: BodyState[],
  drag: LoopDragInfo,
): Float64Array {
  let total = 0;
  // First pass: count residuals to size the buffer once.
  for (const lm of loopMates) total += residualDimension(lm.mate.type);
  const dragApplies =
    drag.draggedInstanceId !== undefined
    && drag.draggedCursorWorld !== undefined
    && drag.draggedGrabLocal !== undefined
    && loopBodies.some(b => b.instanceId === drag.draggedInstanceId);
  if (dragApplies) total += 3;

  const out = new Float64Array(total);
  let i = 0;
  for (const lm of loopMates) {
    const r = matchResidual(lm);
    for (const v of r) {
      out[i++] = v;
    }
  }
  if (dragApplies) {
    const dragged = loopBodies.find(b => b.instanceId === drag.draggedInstanceId)!;
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

function packBodies(loopBodies: BodyState[], x: Float64Array): void {
  for (let i = 0; i < loopBodies.length; i++) {
    const b = loopBodies[i];
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

function unpackBodies(loopBodies: BodyState[], x: Float64Array): void {
  for (let i = 0; i < loopBodies.length; i++) {
    const b = loopBodies[i];
    const off = i * 7;
    b.position.set(x[off], x[off + 1], x[off + 2]);
    // Three.js's applyQuaternion assumes unit-norm input; LM's FD step
    // perturbs quat components individually, which breaks normalization.
    // Normalize on every unpack so residual functions always see a unit
    // quaternion even during Jacobian evaluation.
    b.quaternion.set(x[off + 3], x[off + 4], x[off + 5], x[off + 6]).normalize();
  }
}
