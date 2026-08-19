// Diagnostics at the current params (run after solve): DOF per the
// rank of the base Jacobian, conflicting rows (residual above
// tolerance at convergence), and redundant rows (satisfied but not
// rank-raising, attributed by greedy column-pivoted QR). Everything
// is keyed by constraint id; internal (negative-id) records can
// appear and are the statement layer's job to map onto entities.

import { matrixRankWithPivots } from '../solver-core/index.js';
import { connectedComponents } from './decompose.js';
import type { SketchSystem } from './system.js';
import type { ComponentDiagnostics, DiagnoseOptions, SketchDiagnostics } from './types.js';

/**
 * Internal rows are scaled above user rows before rank attribution
 * so an interchangeable redundant group names the user's statement,
 * never an auto-added arc-consistency row.
 */
const INTERNAL_ROW_SCALE = 10;

export function diagnose(sys: SketchSystem, opts: DiagnoseOptions = {}): SketchDiagnostics {
  const conflictTol = opts.conflictTol ?? 1e-6;
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

  for (const component of components) {
    const n = component.params.length;
    const m = component.rows.length;
    if (m === 0) {
      dof += n;
      componentInfos.push({ paramCount: n, dof: n });
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
    const { rank, pivots } = matrixRankWithPivots(Jt, n, m);
    const pivotSet = new Set(pivots);
    for (let k = 0; k < m; k++) {
      const id = records[compiled.rowConstraint[component.rows[k]]].id;
      if (Math.abs(residuals[k]) > conflictTol) {
        conflicting.add(id);
      } else if (!pivotSet.has(k)) {
        redundant.add(id);
      }
    }
    dof += n - rank;
    componentInfos.push({ paramCount: n, dof: n - rank });
  }

  for (const k of inertRows) {
    const id = records[compiled.rowConstraint[k]].id;
    if (Math.abs(compiled.rows[k].eval(values)) > conflictTol) {
      conflicting.add(id);
    } else {
      redundant.add(id);
    }
  }

  for (const id of conflicting) {
    redundant.delete(id);
  }
  return {
    dof,
    conflicting: [...conflicting].sort((a, b) => a - b),
    redundant: [...redundant].sort((a, b) => a - b),
    components: componentInfos,
  };
}
