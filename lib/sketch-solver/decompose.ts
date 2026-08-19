// Decomposition of the param↔constraint graph: connected components
// (solved independently), reverse Cuthill-McKee param ordering (keeps
// the normal matrix's envelope narrow — the P0 verdict's banded-
// Cholesky enabler), and the solve-plan builder that compiles a
// component into the sparse structures runLMSparse consumes.

import { createSparseLMWorkspace } from '../solver-core/index.js';
import type { SparseLMWorkspace, SparseStructure } from '../solver-core/index.js';
import type { CompiledRow } from './constraints/types.js';
import type { CompiledSystem } from './system.js';

export type Components = {
  /** Free-param groups (ascending global index) with their rows
   * (ascending row index). Components with zero rows are entities
   * nothing constrains — they still count toward DOF. Ordered by
   * smallest member param. */
  components: { params: number[]; rows: number[] }[];
  /** Rows touching no free param (e.g. constraints between fixed
   * reference entities): unsolvable, classified by diagnose. */
  inertRows: number[];
};

export function connectedComponents(
  rows: readonly CompiledRow[],
  paramCount: number,
  freeMask: Uint8Array,
): Components {
  const parent = new Int32Array(paramCount);
  for (let i = 0; i < paramCount; i++) {
    parent[i] = i;
  }
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      // Smaller root wins: component identity is its smallest param.
      if (ra < rb) {
        parent[rb] = ra;
      } else {
        parent[ra] = rb;
      }
    }
  };
  const inertRows: number[] = [];
  const rowAnchor = new Int32Array(rows.length).fill(-1);
  for (let k = 0; k < rows.length; k++) {
    let anchor = -1;
    for (const gp of rows[k].params) {
      if (!freeMask[gp]) {
        continue;
      }
      if (anchor === -1) {
        anchor = gp;
      } else {
        union(anchor, gp);
      }
    }
    rowAnchor[k] = anchor;
    if (anchor === -1) {
      inertRows.push(k);
    }
  }
  const byRoot = new Map<number, { params: number[]; rows: number[] }>();
  for (let i = 0; i < paramCount; i++) {
    if (!freeMask[i]) {
      continue;
    }
    const root = find(i);
    let group = byRoot.get(root);
    if (!group) {
      group = { params: [], rows: [] };
      byRoot.set(root, group);
    }
    group.params.push(i);
  }
  for (let k = 0; k < rows.length; k++) {
    if (rowAnchor[k] !== -1) {
      byRoot.get(find(rowAnchor[k]))!.rows.push(k);
    }
  }
  const components = [...byRoot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => group);
  return { components, inertRows };
}

/**
 * Reverse Cuthill-McKee over one component's params, with adjacency
 * from its rows (params sharing a row are neighbors). Deterministic:
 * degree ties break on global param index. Returns the params
 * reordered.
 */
export function rcmOrder(
  params: number[],
  rows: number[],
  allRows: readonly CompiledRow[],
  freeMask: Uint8Array,
): number[] {
  const n = params.length;
  if (n <= 2) {
    return params.slice();
  }
  const local = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    local.set(params[i], i);
  }
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (const k of rows) {
    const members: number[] = [];
    for (const gp of allRows[k].params) {
      if (freeMask[gp]) {
        const li = local.get(gp);
        if (li !== undefined && !members.includes(li)) {
          members.push(li);
        }
      }
    }
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        adj[members[a]].add(members[b]);
        adj[members[b]].add(members[a]);
      }
    }
  }
  const neighbors: number[][] = adj.map((s) =>
    [...s].sort((a, b) => adj[a].size - adj[b].size || params[a] - params[b]),
  );
  const degree = (i: number): number => adj[i].size;

  // Pseudo-peripheral start: min degree, then push to the far end of
  // a BFS level structure (two sweeps).
  const bfsFarthest = (from: number): number => {
    const seen = new Uint8Array(n);
    let frontier = [from];
    seen[from] = 1;
    let last = from;
    while (frontier.length) {
      const next: number[] = [];
      for (const i of frontier) {
        for (const j of neighbors[i]) {
          if (!seen[j]) {
            seen[j] = 1;
            next.push(j);
          }
        }
      }
      if (next.length) {
        next.sort((a, b) => degree(a) - degree(b) || params[a] - params[b]);
        last = next[0];
      }
      frontier = next;
    }
    return last;
  };

  const order: number[] = [];
  const visited = new Uint8Array(n);
  // The component is connected by construction, but isolated params
  // (in no row) have empty adjacency only when the component is a
  // single param — handled by the n <= 2 fast path. Still, sweep all
  // start candidates for safety.
  const startCandidates = Array.from({ length: n }, (_v, i) => i).sort(
    (a, b) => degree(a) - degree(b) || params[a] - params[b],
  );
  for (const candidate of startCandidates) {
    if (visited[candidate]) {
      continue;
    }
    let s = candidate;
    s = bfsFarthest(s);
    s = bfsFarthest(s);
    const queue: number[] = [s];
    visited[s] = 1;
    while (queue.length) {
      const i = queue.shift()!;
      order.push(i);
      const unvisited = neighbors[i].filter((j) => !visited[j]);
      for (const j of unvisited) {
        visited[j] = 1;
        queue.push(j);
      }
    }
  }
  order.reverse();
  return order.map((i) => params[i]);
}

export type PlanComponent = {
  /** Global param indices, RCM order. */
  params: Int32Array;
  /** Indices into the plan's row list, ascending (base < glue < drag). */
  rows: number[];
  /** Leading rows counted in the solved verdict (excludes drag). */
  residualRows: number;
  structure: SparseStructure;
  workspace: SparseLMWorkspace;
  x0: Float64Array;
  evaluateInto: (x: Float64Array, r: Float64Array) => void;
  jacobianInto: (x: Float64Array, vals: Float64Array) => void;
};

export type DragTarget = { x: number; y: number; w: number };

export type SolvePlan = {
  comps: PlanComponent[];
  /** Full-table scratch shared by all component closures. */
  work: Float64Array;
  /** Mutable drag targets, aligned with the drag points that built
   * the plan; solve() updates them each frame. */
  dragTargets: DragTarget[];
  /** Per-component λ memory across warm solves. */
  lambda: Float64Array;
};

/**
 * Build the executable plan for base rows + optional glue pairs
 * (value-coincidence, drag only) + drag points. Cached by the caller
 * per (structural version, glue pairs, drag params) — a drag gesture
 * reuses one plan and only rewrites dragTargets.
 */
export function buildPlan(
  compiled: CompiledSystem,
  gluePairs: { aix: number; aiy: number; bix: number; biy: number }[],
  dragPoints: { ix: number; iy: number }[],
): SolvePlan {
  const work = new Float64Array(compiled.paramCount);
  const dragTargets: DragTarget[] = dragPoints.map(() => ({ x: 0, y: 0, w: 0.1 }));

  const allRows: CompiledRow[] = [...compiled.rows];
  for (const pair of gluePairs) {
    allRows.push(diffRow(pair.aix, pair.bix));
    allRows.push(diffRow(pair.aiy, pair.biy));
  }
  const dragStart = allRows.length;
  for (let i = 0; i < dragPoints.length; i++) {
    const t = dragTargets[i];
    const { ix, iy } = dragPoints[i];
    allRows.push({
      params: [ix],
      eval: (p) => t.w * (p[ix] - t.x),
      jac: (_p, out) => {
        out[0] = t.w;
      },
    });
    allRows.push({
      params: [iy],
      eval: (p) => t.w * (p[iy] - t.y),
      jac: (_p, out) => {
        out[0] = t.w;
      },
    });
  }

  const { components } = connectedComponents(allRows, compiled.paramCount, compiled.freeMask);
  const comps: PlanComponent[] = [];
  for (const component of components) {
    if (component.rows.length === 0) {
      continue;
    }
    const ordered = rcmOrder(component.params, component.rows, allRows, compiled.freeMask);
    const params = Int32Array.from(ordered);
    const n = params.length;
    const compact = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      compact.set(params[i], i);
    }
    const rowIdx = component.rows;
    const m = rowIdx.length;
    const rowStart = new Int32Array(m + 1);
    const colsList: number[] = [];
    // Per row: which value slot each of the row's param slots lands
    // in (fixed params drop out; duplicate params merge).
    const gatherPos: number[][] = [];
    const gatherSlot: number[][] = [];
    let maxSlots = 1;
    let residualRows = 0;
    for (let k = 0; k < m; k++) {
      const row = allRows[rowIdx[k]];
      if (rowIdx[k] < dragStart) {
        residualRows++;
      }
      maxSlots = Math.max(maxSlots, row.params.length);
      const entries: { col: number; slot: number }[] = [];
      for (let s = 0; s < row.params.length; s++) {
        const gp = row.params[s];
        if (compiled.freeMask[gp]) {
          entries.push({ col: compact.get(gp)!, slot: s });
        }
      }
      entries.sort((a, b) => a.col - b.col || a.slot - b.slot);
      rowStart[k] = colsList.length;
      const pos: number[] = [];
      const slot: number[] = [];
      let prevCol = -1;
      for (const entry of entries) {
        if (entry.col !== prevCol) {
          colsList.push(entry.col);
          prevCol = entry.col;
        }
        pos.push(colsList.length - 1);
        slot.push(entry.slot);
      }
      gatherPos.push(pos);
      gatherSlot.push(slot);
    }
    rowStart[m] = colsList.length;
    const structure: SparseStructure = { n, rowStart, cols: Int32Array.from(colsList) };
    const tmp = new Float64Array(maxSlots);
    const scatter = (x: Float64Array): void => {
      for (let i = 0; i < n; i++) {
        work[params[i]] = x[i];
      }
    };
    comps.push({
      params,
      rows: rowIdx,
      residualRows,
      structure,
      workspace: createSparseLMWorkspace(structure),
      x0: new Float64Array(n),
      evaluateInto: (x, r) => {
        scatter(x);
        for (let k = 0; k < m; k++) {
          r[k] = allRows[rowIdx[k]].eval(work);
        }
      },
      jacobianInto: (x, vals) => {
        scatter(x);
        for (let k = 0; k < m; k++) {
          allRows[rowIdx[k]].jac(work, tmp);
          const pos = gatherPos[k];
          const slot = gatherSlot[k];
          for (let s = 0; s < pos.length; s++) {
            vals[pos[s]] += tmp[slot[s]];
          }
        }
      },
    });
  }
  return {
    comps,
    work,
    dragTargets,
    lambda: Float64Array.from(comps, () => 1e-5),
  };
}

function diffRow(a: number, b: number): CompiledRow {
  return {
    params: [a, b],
    eval: (p) => p[a] - p[b],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -1;
    },
  };
}
