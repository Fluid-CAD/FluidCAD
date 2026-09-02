// Diagnostics at the current params (run after solve): DOF per the
// rank of the base Jacobian, conflicting rows (residual above
// tolerance at convergence), redundant rows (satisfied but not
// rank-raising, attributed by greedy column-pivoted QR), and the
// under-constrained ENTITIES (params with nullspace freedom — the
// UI's per-edge constrained tint). Row verdicts are keyed by
// constraint id; internal (negative-id) records can appear and are
// the statement layer's job to map onto entities.

import { matrixRankWithPivots } from '../solver-core/index.js';
import { connectedComponents } from './decompose.js';
import { PARAM_COUNT } from './system.js';
import type { SketchSystem } from './system.js';
import type {
  ComponentDiagnostics,
  ConstraintRecord,
  DiagnoseOptions,
  SketchDiagnostics,
} from './types.js';

/**
 * Internal rows are scaled above user rows before rank attribution
 * so an interchangeable redundant group names the user's statement,
 * never an auto-added arc-consistency row.
 */
const INTERNAL_ROW_SCALE = 10;

/**
 * In a conflicted component LM stops at a least-squares compromise
 * where EVERY coupled row carries residual crumbs proportional to
 * the dominant inconsistency (Jᵀr = 0 spreads it), so an absolute
 * tolerance would name innocent rows. A row is conflicting only if
 * its residual is also a meaningful fraction of the component's
 * worst — solved components (worst ~residualTol) are unaffected.
 */
const CONFLICT_REL_TOL = 1e-3;

/**
 * A param counts as movable when its axis has at least this much norm
 * in the Jacobian's nullspace (rowFreedom is in [0, 1] — the QR ran on
 * unit-normalized gradient columns, so the read is scale-invariant).
 */
const FREEDOM_TOL = 1e-6;

/**
 * Transform-tie rows are structural glue for derived entities (2D
 * copy instances) — never user-addressable, so the verdict sets skip
 * them entirely. In a conflicted component least-squares spreads
 * residual onto tie rows too (Jᵀr = 0), and naming them would point
 * the user at machinery no statement owns; the user rows in the same
 * component carry residual of the same order and get named instead.
 * They still count in worstResidual and rank — only the naming is
 * suppressed.
 */
function isTransformTie(record: ConstraintRecord): boolean {
  return record.internal && record.spec.kind === 'transform-tie';
}

export function diagnose(sys: SketchSystem, opts: DiagnoseOptions = {}): SketchDiagnostics {
  const conflictTol = opts.conflictTol ?? 1e-6 / (opts.lengthScale ?? 1);
  const compiled = sys.compiled();
  const values = sys.values;
  const records = sys.constraints();
  const { components, inertRows } = connectedComponents(
    compiled.rows,
    compiled.paramCount,
    compiled.freeMask,
  );

  const conflicting = new Set<number>();
  const redundant = new Set<number>();
  const componentInfos: ComponentDiagnostics[] = [];
  let dof = 0;
  const tmp = new Float64Array(16);
  // Per-param movability (fixed params stay 0 — they are in no
  // component); attributed to entities after the component loop.
  const movable = new Uint8Array(compiled.paramCount);

  for (const component of components) {
    const n = component.params.length;
    const m = component.rows.length;
    if (m === 0) {
      dof += n;
      componentInfos.push({ paramCount: n, dof: n });
      for (const gp of component.params) {
        movable[gp] = 1;
      }
      continue;
    }
    const compact = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      compact.set(component.params[i], i);
    }
    // Jᵀ (n×m, row-major): column k is constraint row k's gradient
    // over the component's free params.
    const Jt = new Float64Array(n * m);
    const residuals = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const row = compiled.rows[component.rows[k]];
      residuals[k] = row.eval(values);
      if (row.params.length > tmp.length) {
        throw new Error(`sketch-solver: row with ${row.params.length} params exceeds scratch`);
      }
      row.jac(values, tmp);
      for (let s = 0; s < row.params.length; s++) {
        const gp = row.params[s];
        if (compiled.freeMask[gp]) {
          Jt[compact.get(gp)! * m + k] += tmp[s];
        }
      }
    }
    // Normalize each row's gradient to unit norm (rank should read
    // angles, not units), then boost internal rows for attribution.
    for (let k = 0; k < m; k++) {
      let norm2 = 0;
      for (let i = 0; i < n; i++) {
        const v = Jt[i * m + k];
        norm2 += v * v;
      }
      if (norm2 <= 1e-24) {
        continue; // degenerate gradient: never a pivot
      }
      const record = records[compiled.rowConstraint[component.rows[k]]];
      const scale = (record.internal ? INTERNAL_ROW_SCALE : 1) / Math.sqrt(norm2);
      for (let i = 0; i < n; i++) {
        Jt[i * m + k] *= scale;
      }
    }
    const { rank, pivots, rowFreedom } = matrixRankWithPivots(Jt, n, m, { rowFreedom: true });
    const pivotSet = new Set(pivots);
    for (let i = 0; i < n; i++) {
      if (rowFreedom![i] > FREEDOM_TOL) {
        movable[component.params[i]] = 1;
      }
    }
    let worstResidual = 0;
    for (let k = 0; k < m; k++) {
      worstResidual = Math.max(worstResidual, Math.abs(residuals[k]));
    }
    const componentTol = Math.max(conflictTol, CONFLICT_REL_TOL * worstResidual);
    for (let k = 0; k < m; k++) {
      const record = records[compiled.rowConstraint[component.rows[k]]];
      if (isTransformTie(record)) {
        continue;
      }
      if (Math.abs(residuals[k]) > componentTol) {
        conflicting.add(record.id);
      } else if (!pivotSet.has(k)) {
        redundant.add(record.id);
      }
    }
    dof += n - rank;
    componentInfos.push({ paramCount: n, dof: n - rank });
  }

  for (const k of inertRows) {
    const record = records[compiled.rowConstraint[k]];
    if (isTransformTie(record)) {
      continue;
    }
    if (Math.abs(compiled.rows[k].eval(values)) > conflictTol) {
      conflicting.add(record.id);
    } else {
      redundant.add(record.id);
    }
  }

  for (const id of conflicting) {
    redundant.delete(id);
  }

  // Entity attribution: an entity is under-constrained while ANY of its
  // params can still move (a circle with only a radius dim stays
  // listed). Fixed entities have no free params and never appear.
  const underconstrainedEntities: number[] = [];
  for (const entity of sys.entities()) {
    if (entity.fixed) {
      continue;
    }
    const paramEnd = entity.paramOffset + PARAM_COUNT[entity.kind];
    for (let p = entity.paramOffset; p < paramEnd; p++) {
      if (movable[p]) {
        underconstrainedEntities.push(entity.id);
        break;
      }
    }
  }
  underconstrainedEntities.sort((a, b) => a - b);

  return {
    dof,
    conflicting: [...conflicting].sort((a, b) => a - b),
    redundant: [...redundant].sort((a, b) => a - b),
    underconstrainedEntities,
    components: componentInfos,
  };
}
