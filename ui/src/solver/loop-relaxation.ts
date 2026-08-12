// Loop / chain relaxation orchestrator — JOINT-SPACE formulation.
//
// After the spanning-forest warm-start has placed every body, walk each
// connected component of the mate graph and run a Levenberg-Marquardt
// pass when LM has work to do — either:
//
//   (a) the component has a closure edge, OR
//   (b) the user is dragging a body inside the component.
//
// (b) covers chains: e.g. `A grounded → revolute → B → revolute → C`
// where the user drags C. The warm-start's mate-aware drag delta only
// places the dragged body's IMMEDIATE joint; LM treats every tree
// edge's free joint params as variables and the drag as a residual, so
// the entire chain's joint angles cooperate to bring C's grab to the
// cursor (inverse kinematics).
//
// **Variables** are the tree edges' free joint params — θz in RADIANS
// internally, slides in mm (degrees only at the joint-model boundary) —
// plus, ONLY when the component's single root is ungrounded, 6 root
// params (3 position + a 3-component rotation-vector increment composed
// onto the warm-started root orientation). With the multi-source BFS a
// component has either grounded roots (no root vars) or exactly one
// ungrounded root. A 4-bar is 3 variables, not 21.
//
// **Cost**: closure-mate residuals evaluated at the forward-kinematics
// poses, plus an optional drag residual on the dragged body's grab
// point. Tree mates contribute NO residuals — FK through `pose()` makes
// them exact by construction, which is what lets `.limits()` become
// plain box constraints (projected LM: limited params are clamped in
// the `normalize` hook after each accepted step). This closes the old
// gap where limits were bypassed on chained/loop drags.
//
// Drag weighting: for pure chains the drag rows are the ONLY residual —
// no weight needed, nothing to fight. For closures a small weight keeps
// the loop closed when the cursor is unreachable (the rhombus
// regression — closure ≤ 0.1 mm through 100 mm of partly-radial drag —
// is the acceptance gate).
//
// Perf note: reduced coordinates make the centered-FD Jacobian cheap
// (the 85 ms/frame gantry incident that motivated the old skip
// heuristics was 7-params-per-body × full-cluster evaluations; a
// gantry is now a single slide variable). Analytic Jacobians stay a
// deferred option — don't build them speculatively.

import { Quaternion, Vector3 } from 'three';
import type { Component, TreeEdge } from './graph.js';
import {
  JOINT_SPECS,
  clampToLimits,
  extract,
  mergeParams,
  mergeParamsReversed,
  observedFlip,
  pose,
  residual,
  residualDimension,
  residualDrag,
  reversedLimits,
  type JointParams,
  type JointSpec,
  type MateOptions,
} from './joint-model.js';
import { matrixRank, runLM } from './relaxation.js';
import type { BodyState, ConnectorState, MateRecord } from './types.js';

export type LoopDragInfo = {
  draggedInstanceId?: string;
  draggedCursorWorld?: Vector3;
  draggedGrabLocal?: Vector3;
};

// Drag weight when the component has closure edges. The warm-start has
// already placed the dragged body's grab analytically; LM's main job is
// closing the loop. A large drag weight makes LM compromise between
// "grab at cursor" and "loop closed" — visibly opening the closure gap
// during drag — so closure residuals dominate and the drag stays a
// gentle pull toward the reachable configuration nearest the cursor.
const CLOSURE_DRAG_WEIGHT = 0.05;

// Tolerance for the fixed-point check that lets `relaxComponent` skip
// LM entirely. The warm-start cascades drag deltas through fastened +
// single-joint clusters analytically, so x0 often already sits at the
// optimum; one cheap `evaluate(x0)` then saves the Jacobian setup.
const LM_SKIP_THRESHOLD = 1e-6;

type FreeKey = 'rotZ' | 'slideZ' | 'x' | 'y';

/** One tree edge's contribution to the variable vector. */
type EdgeState = {
  edge: TreeEdge;
  spec: JointSpec;
  options: MateOptions;
  /** Chirality-resolved options for pose() (see JointSpec.preserveChirality). */
  poseOptions: MateOptions;
  /**
   * True when the tree traverses the mate from its B side; free params
   * then live in the B-side space and the option-fixed components must
   * be re-derived at the current angle on every FK evaluate.
   */
  reversed: boolean;
  /** Working params; slots are overwritten from x on every evaluate. */
  params: JointParams;
  slots: Array<{ key: FreeKey; index: number }>;
};

/** A box constraint on one variable slot, applied in the normalize hook. */
type LimitEntry = {
  index: number;
  /** Bounds in the variable's own unit (radians for angles, mm for slides). */
  min: number;
  max: number;
  /** Unwrap angles onto the branch nearest this reference (radians); null for slides. */
  unwrapRef: number | null;
};

/**
 * For every component that needs LM (closure edges, or a drag inside
 * the component), run a joint-space relaxation pass. Mutates body poses
 * in-place via forward kinematics when LM converges (or settles on a
 * low-residual config); restores warm-start poses on outright failure.
 *
 * Returns one entry per component: the component's loop DOF
 * (`n_vars − rank(J_closure at the solution)`) when it has closure
 * edges, or `null` when the table-based accounting applies (chains,
 * unrelaxed components, LM failure).
 */
export function applyLoopRelaxations(
  bodies: BodyState[],
  components: Component[],
  drag: LoopDragInfo = {},
): Array<number | null> {
  const loopDof: Array<number | null> = new Array(components.length).fill(null);
  if (components.length === 0) return loopDof;
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  components.forEach((component, i) => {
    if (!shouldRelax(component, drag)) return;
    loopDof[i] = relaxComponent(component, bodyById, drag);
  });
  return loopDof;
}

function shouldRelax(component: Component, drag: LoopDragInfo): boolean {
  if (component.closureEdges.length > 0) return true;
  if (drag.draggedInstanceId === undefined) return false;
  return component.bodies.some(b => b.instanceId === drag.draggedInstanceId);
}

function relaxComponent(
  component: Component,
  bodyById: Map<string, BodyState>,
  drag: LoopDragInfo,
): number | null {
  // Safety net: unreachable from the DSL (lib/core/mate.ts rejects
  // unimplemented mate types at parse time), but it must never be
  // silent — FK cannot pose through an unimplemented tree edge, and an
  // unimplemented closure would silently contribute no rows.
  for (const edge of component.treeEdges) {
    if (!JOINT_SPECS[edge.mate.type]) {
      warnNoModel(edge.mate.type);
      return null;
    }
  }
  for (const closure of component.closureEdges) {
    if (!JOINT_SPECS[closure.type]) {
      warnNoModel(closure.type);
      return null;
    }
  }

  const closures = resolveClosures(component, bodyById);

  // Variable layout: [root pose (6, ungrounded single root only)] then
  // each tree edge's free params in BFS order.
  const edgeStates: EdgeState[] = [];
  const limitEntries: LimitEntry[] = [];
  const ungroundedRoot = component.roots.length === 1 && !component.roots[0].grounded
    ? component.roots[0]
    : null;

  // Drag-only components with an ungrounded root skip LM entirely: the
  // 3-row drag residual under-determines the root's 6 DOF, and the
  // damped step bleeds the correction into ROTATION — the dragged
  // cluster visibly tumbles while following the cursor. The warm-start
  // has already applied the analytic joint drag deltas; the remaining
  // cursor gap is closed by a rigid translation of the whole tree in
  // `applyUngroundedClusterDrag` (solver.ts). Trade-off: floating
  // (ungrounded) multi-joint chains don't get LM inverse kinematics —
  // they translate rigidly beyond the grabbed joint's own motion, which
  // is deterministic and jitter-free.
  if (closures.length === 0 && ungroundedRoot) return null;

  let n = ungroundedRoot ? 6 : 0;

  for (const edge of component.treeEdges) {
    const spec = JOINT_SPECS[edge.mate.type]!;
    const options = edge.mate.options ?? {};
    const reversed = !edge.parentIsA;
    const poseOptions: MateOptions = spec.preserveChirality
      ? {
        ...options,
        flip: observedFlip(edge.parent, edge.parentConn, edge.child, edge.childConn),
      }
      : options;
    const extracted = extract(edge.parent, edge.parentConn, edge.child, edge.childConn);
    const params = reversed
      ? mergeParamsReversed(spec, extracted, poseOptions)
      : mergeParams(spec, extracted, poseOptions);
    // Limits are authored in A-space; reversed edges clamp their
    // B-space variable against the mapped bounds.
    const effLimits = options.limits && reversed
      ? reversedLimits(options.limits, poseOptions.flip)
      : options.limits;
    const slots: EdgeState['slots'] = [];
    const addSlot = (key: FreeKey) => {
      slots.push({ key, index: n });
      if (effLimits && spec.limitParam === key
          && (key === 'rotZ' || key === 'slideZ')) {
        const angular = key === 'rotZ';
        const scale = angular ? Math.PI / 180 : 1;
        limitEntries.push({
          index: n,
          min: effLimits[0] * scale,
          max: effLimits[1] * scale,
          // Reference filled from x0 below — unwrap near this frame's
          // warm-started angle, mirroring the warm-start's clamp.
          unwrapRef: angular ? 0 : null,
        });
      }
      n += 1;
    };
    if (spec.freeRotZ) addSlot('rotZ');
    if (spec.freeSlideZ) addSlot('slideZ');
    if (spec.freeSlideXY) {
      addSlot('x');
      addSlot('y');
    }
    // Fastened edges contribute no slots, but stay in the FK pass so
    // upstream variable changes propagate through the rigid link.
    edgeStates.push({ edge, spec, options, poseOptions, reversed, params, slots });
  }

  const dragApplies =
    drag.draggedInstanceId !== undefined
    && drag.draggedCursorWorld !== undefined
    && drag.draggedGrabLocal !== undefined
    && component.bodies.some(b => b.instanceId === drag.draggedInstanceId);

  // Nothing to optimize (all-fastened / fully grounded): tree mates are
  // exact by construction and no variable could move a closure — any
  // closure misfit is irreducible and the mechanism has zero loop DOF.
  if (n === 0) return closures.length > 0 ? 0 : null;
  // Nothing pulling on the variables.
  if (closures.length === 0 && !dragApplies) return null;

  const dragWeight = component.closureEdges.length > 0 ? CLOSURE_DRAG_WEIGHT : 1;
  const draggedBody = dragApplies ? bodyById.get(drag.draggedInstanceId!) : undefined;

  // x0 from the warm-started state.
  const x0 = new Float64Array(n);
  const rootBase = ungroundedRoot
    ? { position: ungroundedRoot.position.clone(), quaternion: ungroundedRoot.quaternion.clone() }
    : null;
  if (ungroundedRoot && rootBase) {
    x0[0] = rootBase.position.x;
    x0[1] = rootBase.position.y;
    x0[2] = rootBase.position.z;
    // Rotation-vector increment on the warm-started orientation → 0.
    x0[3] = 0; x0[4] = 0; x0[5] = 0;
  }
  for (const es of edgeStates) {
    for (const slot of es.slots) {
      x0[slot.index] = slot.key === 'rotZ'
        ? (es.params.rotZ * Math.PI) / 180
        : es.params[slot.key];
    }
  }
  for (const entry of limitEntries) {
    if (entry.unwrapRef !== null) entry.unwrapRef = x0[entry.index];
  }

  // Save every component body's pose so outright LM failure can restore.
  const saved = component.bodies.map(b => ({
    body: b,
    position: b.position.clone(),
    quaternion: b.quaternion.clone(),
  }));

  const evaluate = (x: Float64Array): Float64Array => {
    applyForwardKinematics(x, ungroundedRoot, rootBase, edgeStates);
    return computeResiduals(closures, dragApplies ? draggedBody : undefined, drag, dragWeight);
  };

  // Loop DOF at a solution point: variables minus the independent
  // closure constraints. The closure block of the Jacobian is rebuilt
  // by centered FD (tiny: closure rows × joint params) and its rank
  // taken via column-pivoted QR. Callers re-run FK afterwards — the FD
  // probes leave the bodies perturbed.
  const closureRowCount = closures.reduce(
    (sum, c) => sum + residualDimension(c.mate.type), 0,
  );
  const closureRankAt = (xAt: Float64Array): number => {
    if (closureRowCount === 0) return 0;
    const J = new Float64Array(closureRowCount * n);
    const x = new Float64Array(xAt);
    for (let j = 0; j < n; j++) {
      const h = 1e-6 * Math.max(1, Math.abs(x[j]));
      const saved0 = x[j];
      x[j] = saved0 + h;
      const rPlus = evaluate(x);
      x[j] = saved0 - h;
      const rMinus = evaluate(x);
      x[j] = saved0;
      for (let k = 0; k < closureRowCount; k++) {
        J[k * n + j] = (rPlus[k] - rMinus[k]) / (2 * h);
      }
    }
    return matrixRank(J, closureRowCount, n);
  };
  const finishWithLoopDof = (xFinal: Float64Array): number | null => {
    if (closures.length === 0) {
      applyForwardKinematics(xFinal, ungroundedRoot, rootBase, edgeStates);
      return null;
    }
    const dof = Math.max(0, n - closureRankAt(xFinal));
    applyForwardKinematics(xFinal, ungroundedRoot, rootBase, edgeStates);
    return dof;
  };

  // Fixed-point skip: the warm-start often already sits at the optimum
  // (analytic single-joint drag, pre-satisfied closures). Costs one
  // evaluate; saves a full Jacobian setup per pointermove.
  const initialResidual = evaluate(x0);
  let initSqr = 0;
  for (let i = 0; i < initialResidual.length; i++) {
    initSqr += initialResidual[i] * initialResidual[i];
  }
  if (Math.sqrt(initSqr) < LM_SKIP_THRESHOLD) {
    return finishWithLoopDof(x0);
  }

  // Projected LM: after each accepted step, clamp limited params onto
  // their box (angles first unwrapped onto the branch nearest this
  // frame's start so a ±180° cut can't flip the clamp).
  const normalize = limitEntries.length > 0
    ? (x: Float64Array): void => {
      for (const entry of limitEntries) {
        let v = x[entry.index];
        if (entry.unwrapRef !== null) {
          v += 2 * Math.PI * Math.round((entry.unwrapRef - v) / (2 * Math.PI));
        }
        x[entry.index] = clampToLimits(v, [entry.min, entry.max]);
      }
    }
    : null;

  const result = runLM(x0, evaluate, normalize);

  // Always accept finite LM output. `runLM` only commits steps that
  // strictly reduce the squared residual, so the final state is
  // monotonically improved over the initial state. Restoring on
  // "didn't reach a tight tolerance" caused jitter during drag: any
  // frame that landed slightly above the threshold would snap back to
  // the warm-start pose, then LM would re-converge the next frame —
  // visible fighting.
  if (Number.isFinite(result.residualNorm)) {
    // Rank + final FK write-back: runLM's last internal evaluate may
    // have been an FD probe or a rejected trial, so `finishWithLoopDof`
    // re-poses at the solution after the rank computation's probes.
    return finishWithLoopDof(result.x);
  }
  for (const s of saved) {
    s.body.position.copy(s.position);
    s.body.quaternion.copy(s.quaternion);
  }
  return null;
}

/**
 * Write the variable vector into body poses: optional root pose, then
 * every tree edge's child re-posed from its (already updated) parent in
 * BFS order. Tree mates are exact by construction after this.
 */
function applyForwardKinematics(
  x: Float64Array,
  ungroundedRoot: BodyState | null,
  rootBase: { position: Vector3; quaternion: Quaternion } | null,
  edgeStates: EdgeState[],
): void {
  if (ungroundedRoot && rootBase) {
    ungroundedRoot.position.set(x[0], x[1], x[2]);
    ungroundedRoot.quaternion
      .copy(rotationVectorQuat(x[3], x[4], x[5]).multiply(rootBase.quaternion));
  }
  for (const es of edgeStates) {
    for (const slot of es.slots) {
      es.params[slot.key] = slot.key === 'rotZ'
        ? (x[slot.index] * 180) / Math.PI
        : x[slot.index];
    }
    // Reversed edges re-derive the option-fixed components at the
    // current angle (they rotate with a free rotZ when the mate has a
    // lateral offset); forward edges pose with the params as-is.
    const poseParams = es.reversed
      ? mergeParamsReversed(es.spec, es.params, es.poseOptions)
      : es.params;
    const target = pose(
      es.edge.parent, es.edge.parentConn, es.edge.childConn, es.poseOptions, poseParams,
    );
    es.edge.child.position.copy(target.position);
    es.edge.child.quaternion.copy(target.quaternion);
  }
}

/** Unit quaternion for the rotation vector (rx, ry, rz) [radians]. */
function rotationVectorQuat(rx: number, ry: number, rz: number): Quaternion {
  const angle = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (angle < 1e-12) return new Quaternion();
  return new Quaternion().setFromAxisAngle(
    new Vector3(rx / angle, ry / angle, rz / angle), angle,
  );
}

type ResolvedClosure = {
  mate: MateRecord;
  a: BodyState;
  b: BodyState;
  aConn: ConnectorState;
  bConn: ConnectorState;
};

/** Closure mates with their body/connector refs resolved (A → B order). */
function resolveClosures(
  component: Component,
  bodyById: Map<string, BodyState>,
): ResolvedClosure[] {
  const out: ResolvedClosure[] = [];
  for (const closure of component.closureEdges) {
    const a = bodyById.get(closure.connectorA.instanceId);
    const b = bodyById.get(closure.connectorB.instanceId);
    if (!a || !b) continue;
    const aConn = a.connectors.find(c => c.connectorId === closure.connectorA.connectorId);
    const bConn = b.connectors.find(c => c.connectorId === closure.connectorB.connectorId);
    if (!aConn || !bConn) continue;
    out.push({ mate: closure, a, b, aConn, bConn });
  }
  return out;
}

function computeResiduals(
  closures: ResolvedClosure[],
  draggedBody: BodyState | undefined,
  drag: LoopDragInfo,
  dragWeight: number,
): Float64Array {
  const rows: number[] = [];
  for (const c of closures) {
    const r = residual(c.mate.type, c.a, c.aConn, c.b, c.bConn, c.mate.options ?? {});
    for (const v of r) rows.push(v);
  }
  if (draggedBody && drag.draggedGrabLocal && drag.draggedCursorWorld) {
    const r = residualDrag(draggedBody, drag.draggedGrabLocal, drag.draggedCursorWorld);
    for (const v of r) rows.push(v * dragWeight);
  }
  return Float64Array.from(rows);
}

function warnNoModel(type: MateRecord['type']): void {
  console.warn(
    `[solver] mate type "${type}" has no joint model — `
    + 'skipping loop relaxation for its entire component',
  );
}
