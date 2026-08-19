// Solve orchestration: warm start from the current params, per-
// component sparse LM with λ memory, fixed-point skip, and the drag
// formulation.
//
// Drag runs in two passes. Pass 1 adds soft weighted target rows on
// the dragged points (plus value-coincidence glue rows, so
// unconstrained chains drag as one cluster) and pulls the geometry
// toward the cursor. Soft rows trade against constraints in least
// squares — an unreachable target would leak weight²·distance into
// the constraints — so pass 2 re-solves *without* the drag rows,
// warm-started from pass 1: a projection back onto the constraint
// manifold at the dragged position. Reachable targets fixed-point
// skip pass 2 in zero iterations; unreachable ones end with
// constraints exact and the point as close as they allow. The
// reported outcome is pass 2's.

import { runLMSparse } from '../solver-core/index.js';
import { buildPlan } from './decompose.js';
import type { SizePin, SolvePlan } from './decompose.js';
import { PARAM_COUNT } from './system.js';
import type { SketchSystem } from './system.js';
import type { ComponentSolveResult, SolveOptions, SolveResult } from './types.js';

const DEFAULT_DRAG_WEIGHT = 0.1;
/** Iteration cap for the drag pass — it only needs to land near the
 * cursor; the polish pass makes constraints exact. */
const DRAG_PASS_MAX_ITERS = 60;
/** Loose relative-progress stop for the drag pass: an unreachable
 * target's optimum has nonzero residual, so run to sub-visual
 * progress, not to the step tolerance. */
const DRAG_PASS_FTOL = 1e-6;
/** Points closer than this (both axes) coincide by value. */
const GLUE_TOL = 1e-6;

// Degenerate-collapse guard. Direction constraints with absolute
// residuals (a vertical's dx, a parallel's cross product) vanish as
// an entity's size → 0, while scale-invariant residuals (angle's
// atan2) stay satisfiable at any tiny size — so LM can "solve" a
// truly conflicting sketch by collapsing an entity (the H + V +
// angle(80°) triangle collapses its vertical leg to ~1e-8 and
// reports solved with nothing for diagnose to name). An entity whose
// guess size was healthy but whose solved size fell to ~0 marks the
// solution bogus: restore its guess params and re-solve with an
// internal size-pin row, so the real inconsistency materializes as
// residual and diagnose names the conflicting constraints. The
// collapse floor is absolute on purpose — escape sizes scale with
// residualTol, not with the sketch.
const COLLAPSED_SIZE = 1e-4;
/** Entities whose guess size was already below this never pin — they
 * were authored degenerate, not collapsed by the solver. */
const HEALTHY_GUESS_SIZE = 1e-3;
/** Pinning one entity can unmask a collapse of another (equal-length
 * chains); bounded whack-a-mole. */
const MAX_PIN_ROUNDS = 3;

export function solve(sys: SketchSystem, opts: SolveOptions = {}): SolveResult {
  const compiled = sys.compiled();
  const drag = opts.drag;
  const dragPoints = (drag?.points ?? []).map((point) => sys.pointIndices(point.ref));
  ensurePlanCache(sys, compiled.version);
  // Glue clusters are stable within a drag gesture (the glue rows
  // hold them at solver tolerance), so recompute them only when the
  // dragged points change — the per-frame sweep and fingerprint
  // rebuild otherwise dominate small frames and churn the GC.
  let gluePairs: GluePair[] = [];
  let glueKey = '';
  if (drag && drag.glue !== false) {
    const dragKey = dragPoints.map((p) => p.ix).join(',');
    const cache = sys.planCache!.glue;
    if (cache && cache.dragKey === dragKey) {
      gluePairs = cache.pairs as GluePair[];
      glueKey = cache.key;
    } else {
      gluePairs = valueCoincidencePairs(sys, compiled.freeMask);
      glueKey = gluePairs.map((p) => `${p.aix}~${p.bix}`).join(',');
      sys.planCache!.glue = { dragKey, pairs: gluePairs, key: glueKey };
    }
  }

  let iters = 0;
  if (drag) {
    const dragPlan = obtainPlan(sys, compiled, glueKey, gluePairs, dragPoints);
    const weight = drag.weight ?? DEFAULT_DRAG_WEIGHT;
    for (let i = 0; i < dragPoints.length; i++) {
      dragPlan.dragTargets[i].x = drag.points[i].x;
      dragPlan.dragTargets[i].y = drag.points[i].y;
      dragPlan.dragTargets[i].w = weight;
    }
    iters += runPlan(sys, dragPlan, {
      ...opts,
      maxIters: Math.min(opts.maxIters ?? DRAG_PASS_MAX_ITERS, DRAG_PASS_MAX_ITERS),
    }, DRAG_PASS_FTOL).iters;
  }
  const finalPlan = obtainPlan(sys, compiled, glueKey, gluePairs, []);
  let result = runPlan(sys, finalPlan, opts);
  iters += result.iters;

  let pins: SizePin[] = [];
  for (let round = 0; round < MAX_PIN_ROUNDS; round++) {
    const fresh = collapsedEntities(sys, pins);
    if (fresh.length === 0) {
      break;
    }
    pins = pins.concat(fresh);
    restoreGuessParams(sys, fresh);
    const pinnedPlan = obtainPlan(sys, compiled, glueKey, gluePairs, [], pins);
    result = runPlan(sys, pinnedPlan, opts);
    iters += result.iters;
  }
  if (pins.length > 0) {
    return { ...result, iters, collapsed: pins.map((pin) => pin.entity) };
  }
  return { ...result, iters };
}

/** Entities (beyond the already-pinned ones) whose size collapsed
 * from a healthy guess to ~zero in the current values. */
function collapsedEntities(sys: SketchSystem, pinned: SizePin[]): SizePin[] {
  const values = sys.values;
  const guesses = sys.guesses;
  const done = new Set(pinned.map((pin) => pin.entity));
  const out: SizePin[] = [];
  for (const e of sys.entities()) {
    if (e.fixed || e.kind === 'point' || done.has(e.id)) {
      continue;
    }
    const o = e.paramOffset;
    if (e.kind === 'line') {
      const guessLen = Math.hypot(guesses[o + 2] - guesses[o], guesses[o + 3] - guesses[o + 1]);
      const len = Math.hypot(values[o + 2] - values[o], values[o + 3] - values[o + 1]);
      if (guessLen >= HEALTHY_GUESS_SIZE && len < COLLAPSED_SIZE) {
        out.push({
          entity: e.id,
          kind: 'length',
          sx: o,
          sy: o + 1,
          ex: o + 2,
          ey: o + 3,
          target: guessLen,
        });
      }
    } else {
      const guessR = Math.abs(guesses[o + 2]);
      const r = Math.abs(values[o + 2]);
      if (guessR >= HEALTHY_GUESS_SIZE && r < COLLAPSED_SIZE) {
        out.push({ entity: e.id, kind: 'radius', ir: o + 2, target: guessR });
      }
    }
  }
  return out;
}

/** A pinned entity restarts from its guesses — at the collapsed
 * values the length-pin gradient is degenerate (0/0). */
function restoreGuessParams(sys: SketchSystem, pins: SizePin[]): void {
  const values = sys.values;
  const guesses = sys.guesses;
  for (const pin of pins) {
    const e = sys.entity(pin.entity);
    const count = PARAM_COUNT[e.kind];
    for (let i = 0; i < count; i++) {
      values[e.paramOffset + i] = guesses[e.paramOffset + i];
    }
  }
}

function ensurePlanCache(sys: SketchSystem, version: number): void {
  if (!sys.planCache || sys.planCache.version !== version) {
    sys.planCache = { version, plans: new Map() };
  }
}

function obtainPlan(
  sys: SketchSystem,
  compiled: ReturnType<SketchSystem['compiled']>,
  glueKey: string,
  gluePairs: GluePair[],
  dragPoints: { ix: number; iy: number }[],
  sizePins: SizePin[] = [],
): SolvePlan {
  const key = `g:${glueKey}|d:${dragPoints.map((p) => p.ix).join(',')}|p:${sizePins
    .map((pin) => pin.entity)
    .join(',')}`;
  const cached = sys.planCache!.plans.get(key);
  if (cached) {
    return cached as SolvePlan;
  }
  const plan = buildPlan(compiled, gluePairs, dragPoints, sizePins);
  sys.planCache!.plans.set(key, plan);
  return plan;
}

function runPlan(
  sys: SketchSystem,
  plan: SolvePlan,
  opts: SolveOptions,
  ftol = 0,
): SolveResult {
  const values = sys.values;
  plan.work.set(values);
  const components: ComponentSolveResult[] = [];
  let iters = 0;
  let residualInfNorm = 0;
  let worst = 0; // 0 solved, 1 didnt-converge, 2 singular
  for (let c = 0; c < plan.comps.length; c++) {
    const comp = plan.comps[c];
    const n = comp.params.length;
    for (let i = 0; i < n; i++) {
      comp.x0[i] = values[comp.params[i]];
    }
    const result = runLMSparse(comp.x0, comp.evaluateInto, comp.jacobianInto, comp.structure, {
      maxIters: opts.maxIters,
      tol: opts.tol,
      residualTol: opts.residualTol,
      residualRows: comp.residualRows,
      initLambda: plan.lambda[c],
      ftol,
      // Identity damping, deliberately: sketch params are uniformly
      // length units (planegcs layout — no angle params), so column
      // equilibration buys nothing, and it inflates directions whose
      // columns collapse at degenerate poses (a free arc endpoint at
      // an axis-aligned position) into huge rejected trial steps —
      // λI keeps under-constrained directions min-norm instead.
      damping: 'identity',
    }, comp.workspace);
    plan.lambda[c] = result.lambda;
    for (let i = 0; i < n; i++) {
      const gp = comp.params[i];
      values[gp] = result.x[i];
      plan.work[gp] = result.x[i];
    }
    components.push({
      outcome: result.outcome,
      iters: result.iters,
      residualInfNorm: result.residualInfNorm,
    });
    iters += result.iters;
    residualInfNorm = Math.max(residualInfNorm, result.residualInfNorm);
    const rank = result.outcome === 'singular' ? 2 : result.outcome === 'didnt-converge' ? 1 : 0;
    worst = Math.max(worst, rank);
  }
  return {
    outcome: worst === 2 ? 'singular' : worst === 1 ? 'didnt-converge' : 'solved',
    iters,
    residualInfNorm,
    components,
  };
}

type GluePair = { aix: number; aiy: number; bix: number; biy: number };

/**
 * Glue pairs between point slots that coincide by value: sweep the
 * slots sorted by (x, y, entity, role) and union everything within
 * GLUE_TOL, then pair each cluster member to its first slot.
 * Deterministic; pairs where both slots are fixed carry no free
 * params and are dropped.
 */
function valueCoincidencePairs(sys: SketchSystem, freeMask: Uint8Array): GluePair[] {
  const values = sys.values;
  const roleOrder: Record<string, number> = { point: 0, start: 1, end: 2, center: 3 };
  const slots = sys
    .pointSlots()
    .map((s) => ({ ...s, x: values[s.ix], y: values[s.iy] }))
    .sort(
      (a, b) =>
        a.x - b.x || a.y - b.y || a.entity - b.entity || roleOrder[a.role] - roleOrder[b.role],
    );
  const parent = slots.map((_s, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length && slots[j].x - slots[i].x <= GLUE_TOL; j++) {
      if (Math.abs(slots[j].y - slots[i].y) <= GLUE_TOL) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) {
          parent[Math.max(ri, rj)] = Math.min(ri, rj);
        }
      }
    }
  }
  const pairs: GluePair[] = [];
  for (let i = 0; i < slots.length; i++) {
    const root = find(i);
    if (root === i) {
      continue;
    }
    const a = slots[root];
    const b = slots[i];
    if (!freeMask[a.ix] && !freeMask[b.ix]) {
      continue;
    }
    pairs.push({ aix: a.ix, aiy: a.iy, bix: b.ix, biy: b.iy });
  }
  return pairs;
}
