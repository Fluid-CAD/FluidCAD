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
// Circle/arc ties require a similarity matrix (MᵀM = s²·I): only then
// does a circle map to a circle and the linear radius row hold.
// Improper maps (det < 0, mirrors) are similarities too and pass.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedPoint } from './types.js';
import { center, end, start } from '../types.js';

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
    case 'circle':
    case 'arc': {
      // Circle-likes only map to circle-likes under a similarity:
      // MᵀM = s²·I, i.e. equal-length orthogonal columns.
      const det = a * d - b * c;
      const s2 = Math.abs(det);
      const slack = SIMILARITY_TOL * Math.max(1, a * a + b * b + c * c + d * d);
      if (
        Math.abs(a * a + c * c - s2) > slack ||
        Math.abs(b * b + d * d - s2) > slack ||
        Math.abs(a * b + c * d) > slack
      ) {
        throw new Error(
          'transform-tie on a circle/arc needs a similarity matrix ' +
            '(rotation/mirror + uniform scale + translation)',
        );
      }
      const rScale = Math.sqrt(s2);
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
