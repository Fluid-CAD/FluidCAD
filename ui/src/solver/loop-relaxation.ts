// Loop / chain relaxation orchestrator — JOINT-SPACE formulation.
//
// After the spanning-forest warm-start has placed every body, walk each
// connected component of the mate graph and run a Levenberg-Marquardt
// pass when LM has work to do — either:
//
//   (a) the component has a closure edge, a contact or a relation, OR
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
// **Relations** (gear, rack-and-pinion) are EXACT: a relation between two
// tree-edge coordinates is linear in them, so relation-groups.ts
// eliminates it — each coupled group of coordinates is driven by one free
// coordinate t and every member is affine in it — and the LM varies t, never
// the members on their own. A relation therefore holds at every LM step, and
// a drag can only move the train the ways the train can move (the
// planetary bug: with a weighted relation row the LM spun a grabbed planet
// against its carrier, breaking the mesh, to bring the grab to the cursor).
// A relation side the LM does not vary on its own coordinate — a closure
// edge — keeps the weighted row (Δb − gain·Δa, relation-model.ts) as a
// documented fallback, and so does every relation of a component whose
// exact solve would leave a closure or contact open (mates win over
// relations; the weighted compromise is today's behaviour there).
//
// **Cost**: closure-mate residuals evaluated at the forward-kinematics
// poses, weighted relation rows for the fallback relations, plus an
// optional drag residual on the dragged body's grab point. Tree mates
// contribute NO residuals — FK through `pose()` makes them exact by
// construction, which is what lets `.limits()` become plain box
// constraints (projected LM: limited params are clamped in the
// `normalize` hook after each accepted step; a coupled group clamps its t
// to the interval where every member is inside its own box, so a limit
// stops the whole train together).
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
  FAILED_MATE_EPS,
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
import {
  contactResidual,
  contactRowCount,
  resolveContact,
  type ResolvedContact,
} from './contact-model.js';
import type { BodyState, ConnectorState, DrivenJoint, MateRecord } from './types.js';
import { RelationModel, type ComponentRelation, type RelationBaseline } from './relation-model.js';
import { RATIO_TOL, RelationGroups, type RelationGroup, type RelationRow } from './relation-groups.js';

export type LoopDragInfo = {
  draggedInstanceId?: string;
  /** See SolverInput.drivenJoint. */
  drivenJoint?: DrivenJoint;
  draggedCursorWorld?: Vector3;
  draggedGrabLocal?: Vector3;
};

/** One component's relaxation outcome. */
export type LoopRelaxation = {
  /**
   * The component's DOF from the rank-based count (`n_vars − rank` over
   * its constraint rows, relations eliminated), or null when the
   * table-based accounting applies (chains, unrelaxed components, LM
   * failure).
   */
  dof: number | null;
  /**
   * Relations dropped because their ratios contradict the others around a
   * cycle (see relation-groups.ts) — reported failed on every solve.
   */
  contradicted: string[];
  /**
   * Relations solved exactly and verified at the final poses. Their sides
   * moved in ratio by construction — however far (a driven step past half a
   * turn included, which the per-solve incremental measure cannot see) —
   * so the failure report trusts them instead of re-measuring.
   */
  exact: string[];
  /**
   * Eliminated relations a limit held off their ratio: a driver pinning a
   * train asked a limited member past its bound (reported failed).
   */
  blocked: string[];
};

const UNRELAXED: LoopRelaxation = { dof: null, contradicted: [], exact: [], blocked: [] };

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

// A relation side is eliminated exactly only when it IS its tree edge's
// coordinate up to sign: the measured side moves ±1 per unit of the
// coordinate (central difference, step SIDE_PROBE_STEP rad / mm). FK makes
// this hold by construction for revolute angles and slider travel; the
// probe is the runtime assertion of that linearity.
const SIDE_PROBE_STEP = 1e-4;
const SIDE_UNIT_TOL = 1e-6;

// After the exact solve each eliminated relation's sides are re-measured at
// the final poses, each on the branch its linear prediction lands on; a
// side further than this (rad for angles, mm for slides) from its
// prediction means the linearization did not hold, and the component
// falls back to the weighted rows. The same tolerance (plus the ratio
// tolerance times the motion, for implied cycle relations) separates a
// held relation from one a limit blocked.
const EXACT_RELATION_TOL = 1e-6;

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

/** One relation linearized at x0 (see linearizeRelations). */
type LinearRelation = {
  relation: ComponentRelation;
  row: RelationRow;
  /** Side values at x0, unwrapped near their baselines (internal units). */
  a0: number;
  b0: number;
  /** Each side's unit slope (±1) in its slot. */
  ca: number;
  cb: number;
  gain: number;
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
 * How the LM's variable vector z maps onto the joint-space vector x: root
 * pose blocks and uncoupled slots are copied, each free relation group's t
 * expands into its members, pinned groups and held slots are constants.
 */
type Parameterization = {
  size: number;
  z0: Float64Array;
  toX: (z: Float64Array) => Float64Array;
  normalize: ((z: Float64Array) => void) | null;
};

/**
 * For every component that needs LM (closure edges, contacts, relations,
 * or a drag inside the component), run a joint-space relaxation pass.
 * Mutates body poses in-place via forward kinematics when LM converges
 * (or settles on a low-residual config); restores warm-start poses on
 * outright failure.
 *
 * Returns one entry per component (see LoopRelaxation).
 */
export function applyLoopRelaxations(
  bodies: BodyState[],
  components: Component[],
  drag: LoopDragInfo = {},
  relationBaselines: Map<string, RelationBaseline> = new Map(),
): LoopRelaxation[] {
  const out: LoopRelaxation[] = components.map(() => UNRELAXED);
  if (components.length === 0) return out;
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  components.forEach((component, i) => {
    if (!shouldRelax(component, drag)) return;
    out[i] = relaxComponent(component, bodyById, drag, relationBaselines);
  });
  return out;
}

function shouldRelax(component: Component, drag: LoopDragInfo): boolean {
  if (component.closureEdges.length > 0) return true;
  // Relations need the elimination (and, for closure sides, the LM rows).
  if (component.relations.length > 0) return true;
  // Contact (tangent) edges are residual-only — LM is the only thing
  // that enforces them, so a component with contacts is never drag-only.
  if (component.contactEdges.length > 0) return true;
  if (drag.draggedInstanceId === undefined) return false;
  return component.bodies.some(b => b.instanceId === drag.draggedInstanceId);
}

function relaxComponent(
  component: Component,
  bodyById: Map<string, BodyState>,
  drag: LoopDragInfo,
  relationBaselines: Map<string, RelationBaseline>,
): LoopRelaxation {
  const unrelaxed = UNRELAXED;
  // Safety net: unreachable from the DSL (lib/core/mate.ts rejects
  // unimplemented mate types at parse time), but it must never be
  // silent — FK cannot pose through an unimplemented tree edge, and an
  // unimplemented closure would silently contribute no rows.
  for (const edge of component.treeEdges) {
    if (!JOINT_SPECS[edge.mate.type]) {
      warnNoModel(edge.mate.type);
      return unrelaxed;
    }
  }
  for (const closure of component.closureEdges) {
    if (!JOINT_SPECS[closure.type]) {
      warnNoModel(closure.type);
      return unrelaxed;
    }
  }

  const closures = resolveClosures(component, bodyById);
  const contacts: ResolvedContact[] = [];
  for (const mate of component.contactEdges) {
    const rc = resolveContact(mate, bodyById);
    if (rc) contacts.push(rc);
  }
  // Relations without a baseline (a side that stopped resolving) drop out
  // of this solve — the graph builder already warned.
  const relations = component.relations.filter(r => relationBaselines.has(r.record.relationId));
  const coupled = closures.length > 0 || contacts.length > 0;

  // Variable layout: [one 6-var pose block (3 pos + 3 rotation-vector)
  // per UNGROUNDED forest root, in roots order] then each tree edge's
  // free params in BFS order. Grounded roots contribute nothing. With
  // the contact-free spanning forest, a body attached to ground only
  // through tangent mates is an additional ungrounded root — that's
  // what forced this multi-root generalization.
  const edgeStates: EdgeState[] = [];
  const limitEntries: LimitEntry[] = [];
  /** Slots a kinematic driver holds: in x (so a relation can read them) but never varied. */
  const heldSlots = new Set<number>();
  const ungroundedRoots = component.roots.filter(r => !r.grounded);

  // Drag-only components with an ungrounded root skip LM entirely: the
  // 3-row drag residual under-determines the root's 6 DOF, and the
  // damped step bleeds the correction into ROTATION — the dragged
  // cluster visibly tumbles while following the cursor. The warm-start
  // has already applied the analytic joint drag deltas; the remaining
  // cursor gap is closed by a rigid translation of the whole tree in
  // `applyUngroundedClusterDrag` (solver.ts). Trade-off: floating
  // (ungrounded) multi-joint chains don't get LM inverse kinematics —
  // they translate rigidly beyond the grabbed joint's own motion, which
  // is deterministic and jitter-free. A component with contact edges is
  // never drag-only — LM is the only thing enforcing the contacts.
  if (!coupled && relations.length === 0 && ungroundedRoots.length > 0) {
    return unrelaxed;
  }
  // A component held together only by relations keeps that trade-off: its
  // ungrounded roots stay where the warm-start put them (relations are
  // relative measures and could not pin a root anyway) and the rigid
  // cluster drag closes the cursor gap; only the joint params vary.
  const rootVars = coupled ? ungroundedRoots : [];
  const rootVarCount = 6 * rootVars.length;

  let n = rootVarCount;

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
    // A driven edge's free scalar is HELD: the warm-start already posed it
    // at the commanded value, and LM must solve the rest of the mechanism
    // around it, never move it. It still gets a slot so a relation on the
    // driven mate can read it (a relation group holding it is pinned).
    const driven = drag.drivenJoint?.mateId === edge.mate.mateId;
    const addSlot = (key: FreeKey) => {
      slots.push({ key, index: n });
      const held = driven && spec.limitParam === key;
      if (held) heldSlots.add(n);
      if (!held && effLimits && spec.limitParam === key
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

  const hasConstraints = closures.length + contacts.length + relations.length > 0;
  // Nothing to optimize (all-fastened / fully grounded): tree mates are
  // exact by construction and no variable could move a closure or a
  // contact — any misfit is irreducible (a both-grounded tangent
  // degenerates to a pure check via collectFailedMates) and the
  // mechanism has zero loop DOF.
  if (n === 0) return { ...UNRELAXED, dof: hasConstraints ? 0 : null };
  // Nothing pulling on the variables.
  if (!coupled && relations.length === 0 && !dragApplies) return unrelaxed;

  // Relations are exactly satisfiable alongside a drag (the other mate
  // follows), so they take the full drag weight like a chain.
  const dragWeight = coupled ? CLOSURE_DRAG_WEIGHT : 1;
  const draggedBody = dragApplies ? bodyById.get(drag.draggedInstanceId!) : undefined;

  // x0 from the warm-started state.
  const x0 = new Float64Array(n);
  const rootStates = rootVars.map((root, i) => ({
    root,
    base: { position: root.position.clone(), quaternion: root.quaternion.clone() },
    offset: 6 * i,
  }));
  for (const rs of rootStates) {
    x0[rs.offset + 0] = rs.base.position.x;
    x0[rs.offset + 1] = rs.base.position.y;
    x0[rs.offset + 2] = rs.base.position.z;
    // Rotation-vector increment on the warm-started orientation → 0.
    x0[rs.offset + 3] = 0; x0[rs.offset + 4] = 0; x0[rs.offset + 5] = 0;
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
  const restore = (): void => {
    for (const s of saved) {
      s.body.position.copy(s.position);
      s.body.quaternion.copy(s.quaternion);
    }
  };

  // Exact relations: linearize every relation whose sides are slots at x0
  // and eliminate them (relation-groups.ts); the rest keep weighted rows.
  const linear = linearizeRelations(
    relations, edgeStates, x0, rootStates, bodyById, relationBaselines,
  );
  const elimination = RelationGroups.eliminate(linear.map(l => l.row), heldSlots);
  const contradicted = new Set(elimination.contradicted);
  const eliminated = new Set(elimination.groups.flatMap(g => g.relationIds));
  const weighted = relations.filter(r =>
    !eliminated.has(r.record.relationId) && !contradicted.has(r.record.relationId));

  const solveWith = (
    param: Parameterization,
    softRelations: ComponentRelation[],
  ): { x: Float64Array; dof: number | null } | null => {
    const evaluate = (z: Float64Array): Float64Array => {
      applyForwardKinematics(param.toX(z), rootStates, edgeStates);
      return computeResiduals(
        closures, contacts, softRelations, bodyById, relationBaselines,
        dragApplies ? draggedBody : undefined, drag, dragWeight,
      );
    };
    // DOF at a solution point: free variables minus the independent
    // constraint rows (closures + contacts + weighted relations — the
    // drag rows are excluded; eliminated relations already removed
    // their coordinates). The constraint block of the Jacobian is rebuilt
    // by centered FD (tiny: constraint rows × variables) and its rank
    // taken via column-pivoted QR. Callers re-run FK afterwards — the FD
    // probes leave the bodies perturbed. Contact rows are per-RECORD
    // (the pair of surface forms fixes the dimension), not per-type.
    const constraintRowCount = closures.reduce(
      (sum, c) => sum + residualDimension(c.mate.type), 0,
    ) + contacts.reduce((sum, rc) => sum + contactRowCount(rc), 0)
      + softRelations.length;
    const k = param.size;
    const constraintRankAt = (zAt: Float64Array): number => {
      if (constraintRowCount === 0 || k === 0) return 0;
      const J = new Float64Array(constraintRowCount * k);
      const z = new Float64Array(zAt);
      for (let j = 0; j < k; j++) {
        const h = 1e-6 * Math.max(1, Math.abs(z[j]));
        const saved0 = z[j];
        z[j] = saved0 + h;
        const rPlus = evaluate(z);
        z[j] = saved0 - h;
        const rMinus = evaluate(z);
        z[j] = saved0;
        for (let r = 0; r < constraintRowCount; r++) {
          J[r * k + j] = (rPlus[r] - rMinus[r]) / (2 * h);
        }
      }
      return matrixRank(J, constraintRowCount, k);
    };
    // Roots kept out of the variables (relations-only components) still
    // carry their 6 free DOF each — they are simply not the LM's to move.
    const fixedRootDof = 6 * (ungroundedRoots.length - rootVars.length);
    const finish = (zFinal: Float64Array): { x: Float64Array; dof: number | null } => {
      const dof = hasConstraints
        ? Math.max(0, k - constraintRankAt(zFinal)) + fixedRootDof
        : null;
      const x = param.toX(zFinal);
      applyForwardKinematics(x, rootStates, edgeStates);
      return { x, dof };
    };

    // Everything held (a driver pinning every coupled coordinate): pose
    // the projected start and report what is left.
    if (k === 0) return finish(param.z0);

    // Fixed-point skip: the warm-start often already sits at the optimum
    // (analytic single-joint drag, pre-satisfied closures). Costs one
    // evaluate; saves a full Jacobian setup per pointermove.
    const initialResidual = evaluate(param.z0);
    let initSqr = 0;
    for (let i = 0; i < initialResidual.length; i++) {
      initSqr += initialResidual[i] * initialResidual[i];
    }
    if (Math.sqrt(initSqr) < LM_SKIP_THRESHOLD) return finish(param.z0);

    const result = runLM(param.z0, evaluate, param.normalize);

    // Always accept finite LM output. `runLM` only commits steps that
    // strictly reduce the squared residual, so the final state is
    // monotonically improved over the initial state. Restoring on
    // "didn't reach a tight tolerance" caused jitter during drag: any
    // frame that landed slightly above the threshold would snap back to
    // the warm-start pose, then LM would re-converge the next frame —
    // visible fighting.
    if (!Number.isFinite(result.residualNorm)) return null;
    // Rank + final FK write-back: runLM's last internal evaluate may
    // have been an FD probe or a rejected trial, so `finish` re-poses at
    // the solution after the rank computation's probes.
    return finish(result.x);
  };

  const contradictedIds = [...contradicted];
  if (elimination.groups.length > 0) {
    const param = buildParameterization(x0, rootVarCount, n, heldSlots, limitEntries, elimination.groups);
    const solved = solveWith(param, weighted);
    if (solved) {
      const check = checkEliminated(linear.filter(l => eliminated.has(l.row.relationId)), solved.x, x0, bodyById);
      if (check.linear && matesHold(closures, contacts)) {
        const blocked = new Set(check.blocked);
        return {
          dof: solved.dof,
          contradicted: contradictedIds,
          exact: [...eliminated].filter(id => !blocked.has(id)),
          blocked: check.blocked,
        };
      }
      if (!check.linear) warnNotLinear(component);
    }
    // Fallback: the exact solve could not close every mate (a relation
    // fighting a fastened or loop mate) or its linearization did not hold
    // — weighted rows for every relation, the LM compromise.
    restore();
  }
  const softAll = relations.filter(r => !contradicted.has(r.record.relationId));
  const plain = buildParameterization(x0, rootVarCount, n, heldSlots, limitEntries, []);
  const solved = solveWith(plain, softAll);
  if (solved) return { ...UNRELAXED, dof: solved.dof, contradicted: contradictedIds };
  restore();
  return { ...UNRELAXED, contradicted: contradictedIds };
}

type RootState = {
  root: BodyState;
  base: { position: Vector3; quaternion: Quaternion };
  /** This root's 6-var block offset in the variable vector. */
  offset: number;
};

/**
 * Write the variable vector into body poses: every ungrounded root's
 * pose block, then every tree edge's child re-posed from its (already
 * updated) parent in BFS order. Tree mates are exact by construction
 * after this.
 */
function applyForwardKinematics(
  x: Float64Array,
  rootStates: RootState[],
  edgeStates: EdgeState[],
): void {
  for (const rs of rootStates) {
    const o = rs.offset;
    rs.root.position.set(x[o], x[o + 1], x[o + 2]);
    rs.root.quaternion
      .copy(rotationVectorQuat(x[o + 3], x[o + 4], x[o + 5]).multiply(rs.base.quaternion));
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

/**
 * The exact relation rows at x0: for every relation whose two sides are
 * tree-edge slots (rotZ of a revolute/cylindrical, slideZ of a
 * slider/cylindrical) the linearized row
 *
 *   c_b·δ_b − gain·c_a·δ_a = −r0,   r0 = (b − b₀) − gain·(a − a₀) at x0,
 *
 * with c the side's measured unit slope (±1) and the baselines the
 * input poses. Relations with a closure-edge side, a side whose slope is
 * not ±1, or a zero gain are left out (they keep the weighted row).
 * Leaves the bodies posed at x0.
 */
function linearizeRelations(
  relations: ComponentRelation[],
  edgeStates: EdgeState[],
  x0: Float64Array,
  rootStates: RootState[],
  bodyById: Map<string, BodyState>,
  baselines: Map<string, RelationBaseline>,
): LinearRelation[] {
  const out: LinearRelation[] = [];
  if (relations.length === 0) return out;
  const slotOf = (mateId: string, key: 'rotZ' | 'slideZ'): number | null => {
    for (const es of edgeStates) {
      if (es.edge.mate.mateId !== mateId) continue;
      return es.slots.find(s => s.key === key)?.index ?? null;
    }
    return null;
  };
  const x = new Float64Array(x0);
  /** Unit slope of a side's measure in its slot, or null when not ±1. */
  const slope = (mate: MateRecord, key: 'rotZ' | 'slideZ', slot: number, at: number): number | null => {
    x[slot] = x0[slot] + SIDE_PROBE_STEP;
    applyForwardKinematics(x, rootStates, edgeStates);
    const plus = RelationModel.measure(mate, key, bodyById, at);
    x[slot] = x0[slot] - SIDE_PROBE_STEP;
    applyForwardKinematics(x, rootStates, edgeStates);
    const minus = RelationModel.measure(mate, key, bodyById, at);
    x[slot] = x0[slot];
    if (plus === null || minus === null) return null;
    const c = (plus - minus) / (2 * SIDE_PROBE_STEP);
    return Math.abs(Math.abs(c) - 1) <= SIDE_UNIT_TOL ? Math.sign(c) : null;
  };
  for (const relation of relations) {
    const baseline = baselines.get(relation.record.relationId);
    if (!baseline) continue;
    const keyA = RelationModel.paramA(relation.record);
    const keyB = RelationModel.paramB(relation.record);
    const slotA = slotOf(relation.mateA.mateId, keyA);
    const slotB = slotOf(relation.mateB.mateId, keyB);
    if (slotA === null || slotB === null) continue;
    const gain = RelationModel.gain(relation.record);
    if (!(Math.abs(gain) > 0) || !Number.isFinite(gain)) continue;
    applyForwardKinematics(x0, rootStates, edgeStates);
    const a = RelationModel.measure(relation.mateA, keyA, bodyById, baseline.a);
    const b = RelationModel.measure(relation.mateB, keyB, bodyById, baseline.b);
    if (a === null || b === null) continue;
    const ca = slope(relation.mateA, keyA, slotA, a);
    const cb = slope(relation.mateB, keyB, slotB, b);
    if (ca === null || cb === null) continue;
    const r0 = (b - baseline.b) - gain * (a - baseline.a);
    out.push({
      relation,
      row: {
        relationId: relation.record.relationId,
        slotA,
        slotB,
        coefA: -gain * ca,
        coefB: cb,
        rhs: -r0,
      },
      a0: a,
      b0: b,
      ca,
      cb,
      gain,
    });
  }
  applyForwardKinematics(x0, rootStates, edgeStates);
  return out;
}

/**
 * Verify the eliminated relations at the final poses (bodies posed at x):
 * every side must sit on its linear prediction (a0 + c·δ, measured on the
 * branch nearest it — so a move past half a turn is checked correctly),
 * else `linear` is false. A relation whose linear row no longer holds was
 * held off its ratio by a limit (a pinned member clamped into its box):
 * `blocked`.
 */
function checkEliminated(
  linear: LinearRelation[],
  x: Float64Array,
  x0: Float64Array,
  bodyById: Map<string, BodyState>,
): { linear: boolean; blocked: string[] } {
  const blocked: string[] = [];
  for (const l of linear) {
    const { relation, row } = l;
    const da = x[row.slotA] - x0[row.slotA];
    const db = x[row.slotB] - x0[row.slotB];
    const predA = l.a0 + l.ca * da;
    const predB = l.b0 + l.cb * db;
    const a = RelationModel.measure(relation.mateA, RelationModel.paramA(relation.record), bodyById, predA);
    const b = RelationModel.measure(relation.mateB, RelationModel.paramB(relation.record), bodyById, predB);
    if (a === null || b === null) continue;
    if (Math.abs(a - predA) > EXACT_RELATION_TOL || Math.abs(b - predB) > EXACT_RELATION_TOL) {
      return { linear: false, blocked: [] };
    }
    // The row: coefA·δa + coefB·δb = rhs.
    const miss = row.coefA * da + row.coefB * db - row.rhs;
    const tol = EXACT_RELATION_TOL + RATIO_TOL * (Math.abs(row.coefA * da) + Math.abs(row.coefB * db));
    if (Math.abs(miss) > tol) blocked.push(row.relationId);
  }
  return { linear: true, blocked };
}

/**
 * The z ↔ x map for one solve (see Parameterization). Uncoupled limited
 * slots clamp in the normalize hook as before (angles unwrapped onto the
 * branch nearest their x0); a free group clamps its t to the interval
 * where every limited member is inside its box, so the train stops as one
 * at the first member's bound. A pinned group's members are constants —
 * a limited member past its bound is clamped on its own (the relation
 * then reports failed: the driver asks for more than the limit allows).
 */
function buildParameterization(
  x0: Float64Array,
  rootVarCount: number,
  n: number,
  heldSlots: ReadonlySet<number>,
  limitEntries: LimitEntry[],
  groups: RelationGroup[],
): Parameterization {
  const limitBySlot = new Map(limitEntries.map(e => [e.index, e]));
  const grouped = new Set(groups.flatMap(g => g.members.map(m => m.slot)));
  const plainSlots: number[] = [];
  for (let i = rootVarCount; i < n; i++) {
    if (!grouped.has(i) && !heldSlots.has(i)) plainSlots.push(i);
  }
  const freeGroups = groups.filter(g => !g.pinned);
  const size = rootVarCount + plainSlots.length + freeGroups.length;
  const tIndex = rootVarCount + plainSlots.length;

  // Unwrap a limited angle onto the branch nearest its reference.
  const unwrap = (entry: LimitEntry, v: number): number =>
    entry.unwrapRef === null ? v : v + 2 * Math.PI * Math.round((entry.unwrapRef - v) / (2 * Math.PI));

  // Each free group's t interval, from its members' boxes on the branch
  // the member starts on.
  const intervals = freeGroups.map(group => RelationGroups.tInterval(group, slot => {
    const entry = limitBySlot.get(slot);
    if (!entry) return null;
    const member = group.members.find(m => m.slot === slot)!;
    const start = x0[slot] + member.p + member.k * group.t0;
    return { min: entry.min, max: entry.max, offset: x0[slot] + (unwrap(entry, start) - start) };
  }));
  const clampT = (g: number, t: number): number => {
    const [lo, hi] = intervals[g];
    // Boxes that don't overlap along the line leave the group where it is.
    if (lo > hi) return freeGroups[g].t0;
    return Math.min(hi, Math.max(lo, t));
  };

  // Pinned members: constant values, each clamped into its own box.
  const pinnedValues = new Map<number, number>();
  for (const group of groups) {
    if (!group.pinned) continue;
    for (const m of group.members) {
      if (heldSlots.has(m.slot)) continue;
      let v = x0[m.slot] + m.p;
      const entry = limitBySlot.get(m.slot);
      if (entry) v = clampToLimits(unwrap(entry, v), [entry.min, entry.max]);
      pinnedValues.set(m.slot, v);
    }
  }

  const z0 = new Float64Array(size);
  for (let i = 0; i < rootVarCount; i++) z0[i] = x0[i];
  plainSlots.forEach((slot, j) => { z0[rootVarCount + j] = x0[slot]; });
  freeGroups.forEach((group, g) => { z0[tIndex + g] = clampT(g, group.t0); });

  const toX = (z: Float64Array): Float64Array => {
    const x = new Float64Array(x0);
    for (let i = 0; i < rootVarCount; i++) x[i] = z[i];
    plainSlots.forEach((slot, j) => { x[slot] = z[rootVarCount + j]; });
    freeGroups.forEach((group, g) => {
      const t = z[tIndex + g];
      for (const m of group.members) x[m.slot] = x0[m.slot] + m.p + m.k * t;
    });
    for (const [slot, v] of pinnedValues) x[slot] = v;
    return x;
  };

  const limitedPlain = plainSlots
    .map((slot, j) => ({ entry: limitBySlot.get(slot), zi: rootVarCount + j }))
    .filter((p): p is { entry: LimitEntry; zi: number } => p.entry !== undefined);
  const limitedGroups = freeGroups
    .map((_, g) => g)
    .filter(g => Number.isFinite(intervals[g][0]) || Number.isFinite(intervals[g][1]));
  // Projected LM: after each accepted step, clamp limited params onto
  // their box (angles first unwrapped onto the branch nearest this
  // frame's start so a ±180° cut can't flip the clamp).
  const normalize = limitedPlain.length > 0 || limitedGroups.length > 0
    ? (z: Float64Array): void => {
      for (const { entry, zi } of limitedPlain) {
        z[zi] = clampToLimits(unwrap(entry, z[zi]), [entry.min, entry.max]);
      }
      for (const g of limitedGroups) z[tIndex + g] = clampT(g, z[tIndex + g]);
    }
    : null;

  return { size, z0, toX, normalize };
}

/** True when every closure and contact is within FAILED_MATE_EPS at the current poses. */
function matesHold(closures: ResolvedClosure[], contacts: ResolvedContact[]): boolean {
  for (const c of closures) {
    for (const v of residual(c.mate.type, c.a, c.aConn, c.b, c.bConn, c.mate.options ?? {})) {
      if (Math.abs(v) > FAILED_MATE_EPS) return false;
    }
  }
  for (const rc of contacts) {
    for (const v of contactResidual(rc)) {
      if (Math.abs(v) > FAILED_MATE_EPS) return false;
    }
  }
  return true;
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
    if (!closure.connectorA || !closure.connectorB) continue;
    const a = bodyById.get(closure.connectorA.instanceId);
    const b = bodyById.get(closure.connectorB.instanceId);
    if (!a || !b) continue;
    const aConn = a.connectors.find(c => c.connectorId === closure.connectorA!.connectorId);
    const bConn = b.connectors.find(c => c.connectorId === closure.connectorB!.connectorId);
    if (!aConn || !bConn) continue;
    out.push({ mate: closure, a, b, aConn, bConn });
  }
  return out;
}

function computeResiduals(
  closures: ResolvedClosure[],
  contacts: ResolvedContact[],
  relations: ComponentRelation[],
  bodyById: Map<string, BodyState>,
  relationBaselines: Map<string, RelationBaseline>,
  draggedBody: BodyState | undefined,
  drag: LoopDragInfo,
  dragWeight: number,
): Float64Array {
  const rows: number[] = [];
  for (const c of closures) {
    const r = residual(c.mate.type, c.a, c.aConn, c.b, c.bConn, c.mate.options ?? {});
    for (const v of r) rows.push(v);
  }
  // Contact and relation rows follow the closures so the [closure +
  // contact + relation] block stays the leading constraint slice the rank
  // computation reads.
  for (const rc of contacts) {
    const r = contactResidual(rc);
    for (const v of r) rows.push(v);
  }
  for (const relation of relations) {
    // A baseline was required for the relation to be in this list; the
    // sides resolved then, so they resolve now (the same bodies).
    rows.push(RelationModel.residual(relation, bodyById, relationBaselines) ?? 0);
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

const warnedNotLinear = new Set<string>();

/** Tripwire: an eliminated relation that did not hold after the exact solve. */
function warnNotLinear(component: Component): void {
  const ids = component.relations.map(r => r.record.relationId).join(', ');
  if (warnedNotLinear.has(ids)) return;
  warnedNotLinear.add(ids);
  console.warn(
    `[solver] relations ${ids} did not hold after the exact solve — `
    + 'falling back to the weighted relation rows',
  );
}
