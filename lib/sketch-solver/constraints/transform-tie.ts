// transform-tie — internal: rigidly derives a target entity (a 2D
// copy instance) from its source through the affine map
// p' = [[a,b],[c,d]]·p + [tx,ty], matrix = [a, b, c, d, tx, ty].
// Every row is LINEAR in the params (constant Jacobian), one row per
// target param, so a tied entity contributes zero net DOF and the
// coupling is bidirectional: constraining the duplicate solves the
// source through the tie and vice versa.
//
// Per-kind row layout (planegcs param layouts — all point params, no
// angles anywhere, so no rotation-angle constant is ever needed):
//   point  [x,y]                 → 2 rows: q − (M·s + t)
//   line   [sx,sy,ex,ey]         → 4 rows: both endpoints mapped
//   circle [cx,cy,r]             → 3 rows: center mapped + r_t = √|det M|·r_s
//   arc    [cx,cy,r,sx,sy,ex,ey] → 7 rows: center/start/end mapped +
//                                   the radius row (start→start,
//                                   end→end pointwise; a det<0 mirror
//                                   flips the sweep implicitly — the
//                                   caller decides whether to swap
//                                   endpoints when building the copy)
//   ellipse [cx,cy,rx,ry,θ]      → 5 rows: center mapped + both radii
//                                   scaled like a circle's + the RX axis
//                                   direction mapped (cross(u_t, M·u_s) = 0
//                                   — the one non-linear row here,
//                                   π-periodic like the ellipse itself)
// Circle/arc/ellipse ties require a similarity matrix (MᵀM = s²·I): only
// then does a circle map to a circle and the linear radius row hold.
// Improper maps (det < 0, mirrors) are similarities too and pass.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedEllipse, ResolvedPoint } from './types.js';
import { center, end, start } from '../types.js';
import { floorDist } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'transform-tie' }>;

/** Similarity slack, relative to ‖M‖²_F (with a unit floor). */
const SIMILARITY_TOL = 1e-9;

export function compileTransformTie(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const [a, b, c, d, tx, ty] = spec.matrix;
  if (spec.source === spec.target) {
    throw new Error(`transform-tie source and target are the same entity ${spec.source}`);
  }
  const kind = ctx.kindOf(spec.source);
  const targetKind = ctx.kindOf(spec.target);
  if (kind !== targetKind) {
    throw new Error(
      `transform-tie needs entities of the same kind, got ${kind} source ${spec.source} ` +
        `and ${targetKind} target ${spec.target}`,
    );
  }

  // Two rows tying target point q to source point s: q = M·s + t.
  const pointRows = (s: ResolvedPoint, q: ResolvedPoint): CompiledRow[] => [
    {
      params: [q.ix, s.ix, s.iy],
      eval: (p) => p[q.ix] - (a * p[s.ix] + b * p[s.iy] + tx),
      jac: (_p, out) => {
        out[0] = 1;
        out[1] = -a;
        out[2] = -b;
      },
    },
    {
      params: [q.iy, s.ix, s.iy],
      eval: (p) => p[q.iy] - (c * p[s.ix] + d * p[s.iy] + ty),
      jac: (_p, out) => {
        out[0] = 1;
        out[1] = -c;
        out[2] = -d;
      },
    },
  ];

  switch (kind) {
    case 'point':
      return pointRows(
        ctx.point({ entity: spec.source }, 'transform-tie source'),
        ctx.point({ entity: spec.target }, 'transform-tie target'),
      );
    case 'line':
      return [
        ...pointRows(
          ctx.point(start(spec.source), 'transform-tie source start'),
          ctx.point(start(spec.target), 'transform-tie target start'),
        ),
        ...pointRows(
          ctx.point(end(spec.source), 'transform-tie source end'),
          ctx.point(end(spec.target), 'transform-tie target end'),
        ),
      ];
    case 'ellipse': {
      requireSimilarity(a, b, c, d, 'ellipse');
      const rScale = Math.sqrt(Math.abs(a * d - b * c));
      const es = ctx.ellipse({ entity: spec.source }, 'transform-tie source');
      const et = ctx.ellipse({ entity: spec.target }, 'transform-tie target');
      return [
        ...pointRows(
          ctx.point(center(spec.source), 'transform-tie source center'),
          ctx.point(center(spec.target), 'transform-tie target center'),
        ),
        scaledRow(et.rx, es.rx, rScale),
        scaledRow(et.ry, es.ry, rScale),
        ellipseAxisRow(es, et, a, b, c, d),
      ];
    }
    case 'circle':
    case 'arc': {
      requireSimilarity(a, b, c, d, 'circle/arc');
      const rScale = Math.sqrt(Math.abs(a * d - b * c));
      const cs = ctx.circle({ entity: spec.source }, 'transform-tie source');
      const ct = ctx.circle({ entity: spec.target }, 'transform-tie target');
      const rows = [
        ...pointRows(
          ctx.point(center(spec.source), 'transform-tie source center'),
          ctx.point(center(spec.target), 'transform-tie target center'),
        ),
        {
          params: [ct.r, cs.r],
          eval: (p: Float64Array) => p[ct.r] - rScale * p[cs.r],
          jac: (_p: Float64Array, out: Float64Array) => {
            out[0] = 1;
            out[1] = -rScale;
          },
        },
      ];
      if (kind === 'arc') {
        rows.push(
          ...pointRows(
            ctx.point(start(spec.source), 'transform-tie source start'),
            ctx.point(start(spec.target), 'transform-tie target start'),
          ),
          ...pointRows(
            ctx.point(end(spec.source), 'transform-tie source end'),
            ctx.point(end(spec.target), 'transform-tie target end'),
          ),
        );
      }
      return rows;
    }
  }
}

/** target = scale · source — the radius row of a circle-like tie. */
function scaledRow(target: number, source: number, scale: number): CompiledRow {
  return {
    params: [target, source],
    eval: (p) => p[target] - scale * p[source],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -scale;
    },
  };
}

/** Circle-likes only map to circle-likes under a similarity: MᵀM = s²·I,
 * i.e. equal-length orthogonal columns. */
function requireSimilarity(a: number, b: number, c: number, d: number, what: string): void {
  const s2 = Math.abs(a * d - b * c);
  const slack = SIMILARITY_TOL * Math.max(1, a * a + b * b + c * c + d * d);
  if (
    Math.abs(a * a + c * c - s2) > slack ||
    Math.abs(b * b + d * d - s2) > slack ||
    Math.abs(a * b + c * d) > slack
  ) {
    throw new Error(
      `transform-tie on a ${what} needs a similarity matrix ` +
        '(rotation/mirror + uniform scale + translation)',
    );
  }
}

/**
 * The target's RX axis u_t is the mapped source axis M·u_s:
 * cross(u_t, M·u_s)/|M·u_s| = 0 — dimensionless, zero for u_t parallel OR
 * anti-parallel to the image (the same ellipse either way).
 */
function ellipseAxisRow(
  s: ResolvedEllipse,
  t: ResolvedEllipse,
  a: number,
  b: number,
  c: number,
  d: number,
): CompiledRow {
  return {
    params: [t.th, s.th],
    eval: (p) => {
      const usx = Math.cos(p[s.th]);
      const usy = Math.sin(p[s.th]);
      const mx = a * usx + b * usy;
      const my = c * usx + d * usy;
      const utx = Math.cos(p[t.th]);
      const uty = Math.sin(p[t.th]);
      return (utx * my - uty * mx) / floorDist(Math.hypot(mx, my));
    },
    jac: (p, out) => {
      const usx = Math.cos(p[s.th]);
      const usy = Math.sin(p[s.th]);
      const mx = a * usx + b * usy;
      const my = c * usx + d * usy;
      const len = floorDist(Math.hypot(mx, my));
      const utx = Math.cos(p[t.th]);
      const uty = Math.sin(p[t.th]);
      // ∂u_t/∂θ_t = (−uty, utx).
      out[0] = (-uty * my - utx * mx) / len;
      // ∂(M·u_s)/∂θ_s = M·(−usy, usx); the norm's derivative rides along.
      const dmx = -a * usy + b * usx;
      const dmy = -c * usy + d * usx;
      const f = utx * my - uty * mx;
      const df = utx * dmy - uty * dmx;
      const dlen = (mx * dmx + my * dmy) / len;
      out[1] = (df * len - f * dlen) / (len * len);
    },
  };
}
