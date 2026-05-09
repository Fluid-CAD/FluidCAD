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
import { isFullyLocked, type Component } from './graph.js';
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

// Drag enters the LM cost differently depending on the component shape:
//
// - **Chain (no closure)**: the warm-start's mate-aware drag rotation
//   only places the dragged body's IMMEDIATE follower; for chains
//   like A → B → C with C dragged, B has to rotate too, and that
//   rotation only happens here in LM via a drag residual. Use a
//   moderate weight (0.5) so LM converges to a config where C's grab
//   is at the cursor.
//
// - **Closure (4-bar / scissor / triangle)**: the warm-start has
//   already placed the dragged body's grab at the cursor analytically.
//   LM's only remaining job is to close the loop. Adding a drag
//   residual here makes LM compromise between "grab at cursor" and
//   "loop closed" — visibly opening the closure gap during drag. Use
//   weight 0; the warm-start handles the drag, LM handles the loop.
const CHAIN_DRAG_WEIGHT = 0.5;
const CLOSURE_DRAG_WEIGHT = 0.05;

// Tolerance for the warm-start-residual check that lets `relaxComponent`
// skip LM entirely. Small enough that any case where LM could make
// visually-meaningful progress still falls through (chained-revolute drag
// has initial residuals on the order of the cursor delta — tens of mm —
// far above this threshold), large enough to admit floating-point drift
// in a successful warm-start cascade (slider-on-fastened-cluster: warm-
// start places the grab on the cursor projection exactly, residual is
// machine-epsilon).
const LM_SKIP_THRESHOLD = 1e-6;

/**
 * For every component that needs LM (closure or drag-in-chain), run a
 * relaxation pass. Mutates body poses in-place when LM converges (or
 * settles on a low-residual config); leaves them at warm-start poses
 * on outright failure.
 *
 * `skipComponentIndices` enumerates components that the slvs-solvable
 * path is handling natively (see slvs-loop.ts). Those components have
 * had their loop bodies' lock flags cleared and emit real slvs
 * constraints, so the JS-side LM would just fight slvs.
 */
export function applyLoopRelaxations(
  bodies: BodyState[],
  components: Component[],
  drag: LoopDragInfo = {},
  skipComponentIndices: Set<number> = new Set(),
): void {
  if (components.length === 0) return;
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  components.forEach((component, idx) => {
    if (skipComponentIndices.has(idx)) return;
    if (!shouldRelax(component, drag)) return;
    relaxComponent(component, bodyById, drag);
  });
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
  if (!hasFreedom || !hasMates) return false;

  // Skip LM when the dragged body's tree path to the seed contains at
  // most one non-fastened edge AND the seed is grounded. The warm-start
  // already runs the per-mate-type drag delta for that single non-
  // fastened edge (sliderDragDelta / applyRevoluteDragRotation /
  // cylindricalDragDeltas / planarDragDelta), placing the dragged body's
  // grab on the reachable manifold — LM cannot improve on that, but
  // running it on a heavy fastened cluster (e.g. CNC gantry's slider+
  // fastened-cluster topology) burns ~85ms per pointermove fighting
  // mate residuals against the unreachable perpendicular component of
  // the cursor delta. Multi-non-fastened chains (e.g. chained-revolute
  // IK) genuinely need LM and fall through.
  if (component.seed.grounded) {
    const parentByChild = new Map<string, typeof component.treeEdges[number]>();
    for (const edge of component.treeEdges) {
      parentByChild.set(edge.child.instanceId, edge);
    }
    let nonFastened = 0;
    let cur: string | undefined = drag.draggedInstanceId;
    while (cur !== undefined) {
      const edge = parentByChild.get(cur);
      if (!edge) break;
      if (edge.mate.type !== 'fastened') {
        nonFastened++;
        if (nonFastened > 1) break;
      }
      cur = edge.parent.instanceId;
    }
    if (nonFastened <= 1) return false;
  }

  return true;
}

function relaxComponent(
  component: Component,
  bodyById: Map<string, BodyState>,
  drag: LoopDragInfo,
): void {
  const componentMates = collectComponentMates(component, bodyById);
  if (componentMates === null) return; // unsupported mate type
  if (componentMates.length === 0) return;

  const dragWeight = component.closureEdges.length > 0
    ? CLOSURE_DRAG_WEIGHT
    : CHAIN_DRAG_WEIGHT;

  // Variables: 7 floats per non-grounded body in this component.
  // Includes both loop bodies and chain bodies — the LM doesn't need
  // to distinguish, and including all of them lets a chain's drag
  // propagate up through revolute/slider/etc. links to the root.
  const variableBodies = component.bodies.filter(b => !b.grounded);
  if (variableBodies.length === 0) return;

  // Project the cursor onto the dragged body's reachable manifold so
  // LM doesn't chase an unreachable target — see `projectDrag` for the
  // per-mate-type rules. The controller's drag plane is camera-aligned,
  // so an angled view always gives the cursor a 3D motion that may not
  // be reachable through the body's mate constraints; without this
  // projection LM would fight itself frame-to-frame trying to satisfy
  // a fundamentally unreachable cursor.
  const projectedDrag = projectDrag(drag, bodyById, component);

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
    return computeResiduals(componentMates, variableBodies, projectedDrag, dragWeight);
  };

  // LM-skip when warm-start is already at a fixed point. The warm-start
  // cascades drag deltas through fastened+slider+cylindrical clusters
  // analytically (see `sliderDragDelta` etc.), so for trees whose dragged
  // body is in a 1-DOF cluster of those types, x0 already places the
  // grab at the cursor projection — LM has nothing to improve.
  // The check costs one `evaluate(x0)` call (re-unpacking x0 is a no-op
  // since bodies are already at x0), but saves a full LM iteration's
  // Jacobian setup (2·n FD evaluations) which dominates the per-pointer
  // budget when dragging in a heavy fastened cluster. Tolerance is
  // chosen to be tight enough that any case where LM could make
  // visible progress falls through, while admitting the gantry-style
  // cluster-on-slider drag.
  const initialResidual = evaluate(x0);
  let initSqr = 0;
  for (let i = 0; i < initialResidual.length; i++) {
    initSqr += initialResidual[i] * initialResidual[i];
  }
  if (Math.sqrt(initSqr) < LM_SKIP_THRESHOLD) {
    return;
  }

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
 * Project the cursor onto the dragged body's reachable manifold. The
 * shape of that manifold depends on the dragged body's parent tree
 * edge — i.e., the mate that connects it to its tree-parent:
 *
 *   - `slider` (1 DOF along axis): project onto the axis line through
 *     the grab. The body can only slide along the axis, so the only
 *     reachable point is the closest one on that line. Without this,
 *     a perp cursor component (always present from camera-aligned drag
 *     planes) makes LM compromise on the perp residual by nudging the
 *     parent body — which drags every sibling slider follower along
 *     the rail. That's the "two carriages on one rail and one follows
 *     the other" bug.
 *
 *   - `revolute` / `planar` (perpendicular-plane DOFs): project onto
 *     the plane perpendicular to the connector axis through the grab.
 *     This is the original behavior — drops the unreachable axial
 *     component, keeps the rotation/in-plane direction LM needs.
 *
 *   - body fully locked (path to a grounded ancestor is all fastened
 *     edges): zero drag. The body has no DOFs upstream so any drag
 *     residual just makes LM perturb it pointlessly — the fastened
 *     fixup snaps it back, but the perturbed pose is what the slider /
 *     revolute / etc. fixups for *its followers* read, dragging them
 *     along. That's the "drag the rail and the carriages slide" bug.
 *
 *   - other (`cylindrical`, `fastened`-to-non-locked, no parent edge):
 *     no projection. Cylindrical is full 3D-reachable for small steps
 *     (axis translate + axis rotate); fastened-to-non-locked legitimately
 *     wants the drag to propagate up the chain via LM IK; and a free
 *     root body legitimately wants 3D drag.
 *
 * Returns the original drag info unchanged when there's no drag, no
 * dragged body, or no parent mate to consult.
 */
function projectDrag(
  drag: LoopDragInfo,
  bodyById: Map<string, BodyState>,
  component: Component,
): LoopDragInfo {
  if (
    drag.draggedInstanceId === undefined
    || drag.draggedCursorWorld === undefined
    || drag.draggedGrabLocal === undefined
  ) {
    return drag;
  }
  const dragged = bodyById.get(drag.draggedInstanceId);
  if (!dragged) return drag;

  const parentEdge = component.treeEdges
    .find(e => e.child.instanceId === drag.draggedInstanceId);
  if (!parentEdge) return drag;

  const grabWorld = drag.draggedGrabLocal.clone()
    .applyQuaternion(dragged.quaternion).add(dragged.position);

  if (isFullyLocked(drag.draggedInstanceId, component)) {
    return { ...drag, draggedCursorWorld: grabWorld };
  }

  const parent = parentEdge.parent;
  const parentConn = parentEdge.parentConn;
  const axis = parentConn.localNormal.clone()
    .applyQuaternion(parent.quaternion).normalize();
  if (axis.lengthSq() < 1e-12) return drag;

  const offset = drag.draggedCursorWorld.clone().sub(grabWorld);

  switch (parentEdge.mate.type) {
    case 'slider': {
      // Reachable manifold: line through grab parallel to axis. Project
      // cursor onto that line — drops the perpendicular component the
      // mate forbids, keeps the axial component the warm-start has
      // already moved the body along.
      const along = offset.dot(axis);
      const projected = grabWorld.clone().addScaledVector(axis, along);
      return { ...drag, draggedCursorWorld: projected };
    }
    case 'revolute':
    case 'planar': {
      // Reachable manifold: plane through grab perpendicular to axis.
      // Drop the axial component the mate forbids.
      const along = offset.dot(axis);
      if (Math.abs(along) < 1e-9) return drag;
      const projected = drag.draggedCursorWorld.clone()
        .addScaledVector(axis, -along);
      return { ...drag, draggedCursorWorld: projected };
    }
    default:
      return drag;
  }
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
  dragWeight: number,
): Float64Array {
  let total = 0;
  for (const lm of componentMates) total += residualDimension(lm.mate.type);
  const dragApplies =
    dragWeight > 0
    && drag.draggedInstanceId !== undefined
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
      out[i++] = v * dragWeight;
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
