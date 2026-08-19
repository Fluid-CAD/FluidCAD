// Synthetic sketch systems for the solver-core benchmark (P0 of the
// sketch rewrite): a rounded-staircase chain of H/V lines joined by
// tangent quarter-arcs, with the P1 entity layout (every entity owns
// its params; coincidence is a residual) and the P1 constraint flavors
// (fix, coincident, horizontal/vertical, length/radius dims, arc
// consistency, signed line-arc tangency). Exact solution is built in
// closed form so cold solves have a known answer and warm solves a
// perfect starting point.

const SEG_LEN = 10;
const ARC_R = 3;

type Row =
  // x[a] - t
  | { type: "val"; a: number; t: number }
  // x[a] - x[b]
  | { type: "diff"; a: number; b: number }
  // hypot(x[a]-x[b], x[c]-x[d]) - (r >= 0 ? x[r] : t)
  | { type: "dist"; a: number; b: number; c: number; d: number; r: number; t: number }
  // cross(e-s, c-s)/|e-s| - side·x[r]  (line sx,sy,ex,ey; arc cx,cy,r)
  | {
      type: "tangent";
      sx: number;
      sy: number;
      ex: number;
      ey: number;
      cx: number;
      cy: number;
      r: number;
      side: number;
    };

export type SyntheticSystem = {
  n: number;
  m: number;
  entityCount: number;
  lineCount: number;
  arcCount: number;
  dimCount: number;
  xExact: Float64Array;
  /** Reuses one output buffer across calls (runLM copies what it keeps). */
  evaluate: (x: Float64Array) => Float64Array;
  /** Analytic rows; expects J pre-zeroed (the runLM contract). */
  jacobian: (x: Float64Array, J: Float64Array) => void;
  /** Param indices of the chain tip (the last entity's end point). */
  tipIx: number;
  tipIy: number;
};

/**
 * Build a chain of `entityCount` entities cycling through
 * [H line, CCW quarter-arc, V line, CW quarter-arc]. With
 * `dimFraction = 1` every line has a length dim and every arc a radius
 * dim, making the system exactly determined (params == rows); lower
 * fractions skip dims on later entities, leaving free DOF for drag.
 */
export function buildSyntheticSketch(entityCount: number, dimFraction = 1): SyntheticSystem {
  const params: number[] = [];
  const rows: Row[] = [];
  const addParam = (v: number): number => {
    params.push(v);
    return params.length - 1;
  };

  type Entity =
    | { kind: "line"; sx: number; sy: number; ex: number; ey: number }
    | { kind: "arc"; cx: number; cy: number; r: number; sx: number; sy: number; ex: number; ey: number };
  const entities: Entity[] = [];

  let lineCount = 0;
  let arcCount = 0;
  let dimCount = 0;
  // Cursor walks the exact path.
  let px = 0;
  let py = 0;
  for (let i = 0; i < entityCount; i++) {
    const phase = i % 4;
    const dimmed = i < Math.round(entityCount * dimFraction);
    if (phase === 0 || phase === 2) {
      // H line (phase 0) or V line (phase 2).
      const ex = phase === 0 ? px + SEG_LEN : px;
      const ey = phase === 0 ? py : py + SEG_LEN;
      const e: Entity = {
        kind: "line",
        sx: addParam(px),
        sy: addParam(py),
        ex: addParam(ex),
        ey: addParam(ey),
      };
      entities.push(e);
      lineCount++;
      // horizontal: ey == sy; vertical: ex == sx.
      rows.push(
        phase === 0 ? { type: "diff", a: e.ey, b: e.sy } : { type: "diff", a: e.ex, b: e.sx },
      );
      if (dimmed) {
        rows.push({ type: "dist", a: e.ex, b: e.sx, c: e.ey, d: e.sy, r: -1, t: SEG_LEN });
        dimCount++;
      }
      px = ex;
      py = ey;
    } else if (phase === 1) {
      // CCW quarter-arc turning +x into +y: center above the start.
      const e: Entity = {
        kind: "arc",
        cx: addParam(px),
        cy: addParam(py + ARC_R),
        r: addParam(ARC_R),
        sx: addParam(px),
        sy: addParam(py),
        ex: addParam(px + ARC_R),
        ey: addParam(py + ARC_R),
      };
      entities.push(e);
      arcCount++;
      pushArcRows(rows, e, dimmed);
      if (dimmed) dimCount++;
      px = px + ARC_R;
      py = py + ARC_R;
    } else {
      // CW quarter-arc turning +y into +x: center right of the start.
      const e: Entity = {
        kind: "arc",
        cx: addParam(px + ARC_R),
        cy: addParam(py),
        r: addParam(ARC_R),
        sx: addParam(px),
        sy: addParam(py),
        ex: addParam(px + ARC_R),
        ey: addParam(py + ARC_R),
      };
      entities.push(e);
      arcCount++;
      pushArcRows(rows, e, dimmed);
      if (dimmed) dimCount++;
      px = px + ARC_R;
      py = py + ARC_R;
    }
  }

  // Anchor the chain start.
  const first = entities[0] as Extract<Entity, { kind: "line" }>;
  rows.push({ type: "val", a: first.sx, t: 0 });
  rows.push({ type: "val", a: first.sy, t: 0 });

  // A chain that ends on an arc leaves the arc's endpoint one sweep
  // DOF (no next line to be tangent to). When that arc carries a dim,
  // pin the endpoint coordinate that lies along the outgoing tangent
  // so the fully-dimensioned flavor stays exactly determined; the
  // drag flavors leave the tip free.
  const lastIndex = entityCount - 1;
  const last0 = entities[lastIndex];
  if (last0.kind === "arc" && lastIndex < Math.round(entityCount * dimFraction)) {
    const pinParam = lastIndex % 4 === 1 ? last0.ey : last0.ex;
    rows.push({ type: "val", a: pinParam, t: params[pinParam] });
  }

  // Chain coincidence + tangency between neighbors.
  for (let i = 1; i < entities.length; i++) {
    const prev = entities[i - 1];
    const cur = entities[i];
    rows.push({ type: "diff", a: endX(prev), b: startX(cur) });
    rows.push({ type: "diff", a: endY(prev), b: startY(cur) });
    if (cur.kind === "arc" && prev.kind === "line") {
      rows.push(tangentRow(prev, cur));
    } else if (cur.kind === "line" && prev.kind === "arc") {
      rows.push(tangentRow(cur, prev));
    }
  }

  const n = params.length;
  const m = rows.length;
  const xExact = new Float64Array(params);
  const out = new Float64Array(m);

  const evaluate = (x: Float64Array): Float64Array => {
    for (let k = 0; k < m; k++) {
      const row = rows[k];
      switch (row.type) {
        case "val":
          out[k] = x[row.a] - row.t;
          break;
        case "diff":
          out[k] = x[row.a] - x[row.b];
          break;
        case "dist": {
          const target = row.r >= 0 ? x[row.r] : row.t;
          out[k] = Math.hypot(x[row.a] - x[row.b], x[row.c] - x[row.d]) - target;
          break;
        }
        case "tangent": {
          const ux = x[row.ex] - x[row.sx];
          const uy = x[row.ey] - x[row.sy];
          const wx = x[row.cx] - x[row.sx];
          const wy = x[row.cy] - x[row.sy];
          const d = Math.hypot(ux, uy);
          out[k] = (ux * wy - uy * wx) / d - row.side * x[row.r];
          break;
        }
      }
    }
    return out;
  };

  const jacobian = (x: Float64Array, J: Float64Array): void => {
    for (let k = 0; k < m; k++) {
      const row = rows[k];
      const base = k * n;
      switch (row.type) {
        case "val":
          J[base + row.a] = 1;
          break;
        case "diff":
          J[base + row.a] = 1;
          J[base + row.b] = -1;
          break;
        case "dist": {
          const dx = x[row.a] - x[row.b];
          const dy = x[row.c] - x[row.d];
          const d = Math.hypot(dx, dy);
          J[base + row.a] = dx / d;
          J[base + row.b] = -dx / d;
          J[base + row.c] = dy / d;
          J[base + row.d] = -dy / d;
          if (row.r >= 0) J[base + row.r] = -1;
          break;
        }
        case "tangent": {
          const ux = x[row.ex] - x[row.sx];
          const uy = x[row.ey] - x[row.sy];
          const wx = x[row.cx] - x[row.sx];
          const wy = x[row.cy] - x[row.sy];
          const d = Math.hypot(ux, uy);
          const cr = ux * wy - uy * wx;
          // g = cr/d - side·r; quotient rule for the line params, whose
          // moves change both cr and d.
          const dEx = wy;
          const dEy = -wx;
          const dSx = uy - wy;
          const dSy = wx - ux;
          const dDdEx = ux / d;
          const dDdEy = uy / d;
          const d2 = d * d;
          J[base + row.ex] = (dEx * d - cr * dDdEx) / d2;
          J[base + row.ey] = (dEy * d - cr * dDdEy) / d2;
          J[base + row.sx] = (dSx * d - cr * -dDdEx) / d2;
          J[base + row.sy] = (dSy * d - cr * -dDdEy) / d2;
          J[base + row.cx] = -uy / d;
          J[base + row.cy] = ux / d;
          J[base + row.r] = -row.side;
          break;
        }
      }
    }
  };

  const last = entities[entities.length - 1];
  return {
    n,
    m,
    entityCount,
    lineCount,
    arcCount,
    dimCount,
    xExact,
    evaluate,
    jacobian,
    tipIx: endX(last),
    tipIy: endY(last),
  };

  function startX(e: Entity): number {
    return e.sx;
  }
  function startY(e: Entity): number {
    return e.sy;
  }
  function endX(e: Entity): number {
    return e.ex;
  }
  function endY(e: Entity): number {
    return e.ey;
  }
  function pushArcRows(list: Row[], e: Extract<Entity, { kind: "arc" }>, dimmed: boolean): void {
    // Internal consistency: |start-center| == r, |end-center| == r.
    list.push({ type: "dist", a: e.sx, b: e.cx, c: e.sy, d: e.cy, r: e.r, t: 0 });
    list.push({ type: "dist", a: e.ex, b: e.cx, c: e.ey, d: e.cy, r: e.r, t: 0 });
    if (dimmed) {
      list.push({ type: "val", a: e.r, t: ARC_R });
    }
  }
  function tangentRow(
    line: Extract<Entity, { kind: "line" }>,
    arc: Extract<Entity, { kind: "arc" }>,
  ): Row {
    // Signed side picks the tangency branch: +1 = center left of the
    // line direction (CCW arcs), -1 = right (CW arcs). Phase 1 arcs
    // are CCW, phase 3 arcs CW — recover the side from the exact
    // geometry at build time.
    const ux = params[line.ex] - params[line.sx];
    const uy = params[line.ey] - params[line.sy];
    const wx = params[arc.cx] - params[line.sx];
    const wy = params[arc.cy] - params[line.sy];
    const side = ux * wy - uy * wx > 0 ? 1 : -1;
    return {
      type: "tangent",
      sx: line.sx,
      sy: line.sy,
      ex: line.ex,
      ey: line.ey,
      cx: arc.cx,
      cy: arc.cy,
      r: arc.r,
      side,
    };
  }
}

export type DragSystem = {
  evaluate: (x: Float64Array) => Float64Array;
  jacobian: (x: Float64Array, J: Float64Array) => void;
  target: { x: number; y: number };
  /** Rows of the base system only, for post-solve verification. */
  baseM: number;
};

/**
 * Wrap a system with two weighted drag rows pulling (tipIx, tipIy)
 * toward a mutable target — the P4 drag formulation: soft target rows,
 * hard constraints dominate.
 */
export function withDrag(sys: SyntheticSystem, weight = 0.1): DragSystem {
  const m = sys.m + 2;
  const out = new Float64Array(m);
  const target = { x: 0, y: 0 };
  return {
    target,
    baseM: sys.m,
    evaluate: (x: Float64Array): Float64Array => {
      out.set(sys.evaluate(x));
      out[sys.m] = weight * (x[sys.tipIx] - target.x);
      out[sys.m + 1] = weight * (x[sys.tipIy] - target.y);
      return out;
    },
    jacobian: (x: Float64Array, J: Float64Array): void => {
      // Base rows write into the wider matrix directly: same row
      // stride, since n is unchanged.
      sys.jacobian(x, J);
      J[sys.m * sys.n + sys.tipIx] = weight;
      J[(sys.m + 1) * sys.n + sys.tipIy] = weight;
    },
  };
}

/** Deterministic LCG for reproducible guess perturbation. */
export function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** xExact + uniform(-amp, amp) noise on every param. */
export function perturbedGuess(sys: SyntheticSystem, amp: number, seed: number): Float64Array {
  const rand = makeLcg(seed);
  const x = new Float64Array(sys.xExact);
  for (let i = 0; i < x.length; i++) {
    x[i] += (rand() * 2 - 1) * amp;
  }
  return x;
}
