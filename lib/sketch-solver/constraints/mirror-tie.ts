// mirror-tie — internal: rigidly derives a target entity (a 2D mirror
// image) from its source by reflection across an axis line. The axis
// is either a solver LINE entity (a sketched mirror line, a datum axis)
// — then the rows are the symmetric() rows, nonlinear in the line's
// params, so a moving mirror line moves every image with it — or a
// constant line in sketch coordinates (a world axis), where the rows
// reduce to linear ones. One row per target param, so a tied entity
// contributes zero net DOF and the coupling is bidirectional:
// constraining the image solves the source (and the axis) through the
// tie, and vice versa.
//
// Per-kind row layout (planegcs param layouts — all point params):
//   point  [x,y]                 → 2 rows: midpoint on axis + s−q ⊥ axis
//   line   [sx,sy,ex,ey]         → 4 rows: both endpoints reflected
//   circle [cx,cy,r]             → 3 rows: center reflected + r_t = r_s
//   arc    [cx,cy,r,sx,sy,ex,ey] → 7 rows: center/start/end reflected +
//                                   the radius row (start→start, end→end
//                                   pointwise; the solver arc carries no
//                                   sweep param, so the reflected sweep
//                                   is a display choice of the statement)

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedLine, ResolvedPoint } from './types.js';
import { center, end, start } from '../types.js';
import { floorDist, linePointSignedDist, makeLinePointDeriv } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'mirror-tie' }>;

/** A constant axis line in sketch coordinates: [sx, sy, ex, ey]. */
export type FixedAxisLine = [number, number, number, number];

export function compileMirrorTie(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (spec.source === spec.target) {
    throw new Error(`mirror-tie source and target are the same entity ${spec.source}`);
  }
  const kind = ctx.kindOf(spec.source);
  const targetKind = ctx.kindOf(spec.target);
  if (kind !== targetKind) {
    throw new Error(
      `mirror-tie needs entities of the same kind, got ${kind} source ${spec.source} ` +
        `and ${targetKind} target ${spec.target}`,
    );
  }

  const pointRows = Array.isArray(spec.axis)
    ? fixedAxisRows(spec.axis)
    : entityAxisRows(ctx.line(spec.axis, 'mirror-tie axis'));

  switch (kind) {
    case 'point':
      return pointRows(
        ctx.point({ entity: spec.source }, 'mirror-tie source'),
        ctx.point({ entity: spec.target }, 'mirror-tie target'),
      );
    case 'line':
      return [
        ...pointRows(
          ctx.point(start(spec.source), 'mirror-tie source start'),
          ctx.point(start(spec.target), 'mirror-tie target start'),
        ),
        ...pointRows(
          ctx.point(end(spec.source), 'mirror-tie source end'),
          ctx.point(end(spec.target), 'mirror-tie target end'),
        ),
      ];
    case 'circle':
    case 'arc': {
      const cs = ctx.circle({ entity: spec.source }, 'mirror-tie source');
      const ct = ctx.circle({ entity: spec.target }, 'mirror-tie target');
      const rows: CompiledRow[] = [
        ...pointRows(
          ctx.point(center(spec.source), 'mirror-tie source center'),
          ctx.point(center(spec.target), 'mirror-tie target center'),
        ),
        // A reflection is an isometry: the radius rides along unchanged.
        {
          params: [ct.r, cs.r],
          eval: (p) => p[ct.r] - p[cs.r],
          jac: (_p, out) => {
            out[0] = 1;
            out[1] = -1;
          },
        },
      ];
      if (kind === 'arc') {
        rows.push(
          ...pointRows(
            ctx.point(start(spec.source), 'mirror-tie source start'),
            ctx.point(start(spec.target), 'mirror-tie target start'),
          ),
          ...pointRows(
            ctx.point(end(spec.source), 'mirror-tie source end'),
            ctx.point(end(spec.target), 'mirror-tie target end'),
          ),
        );
      }
      return rows;
    }
  }
}

type PointPairRows = (s: ResolvedPoint, q: ResolvedPoint) => CompiledRow[];

/**
 * The two rows reflecting q from s across a solver LINE entity — the
 * symmetric() rows: the midpoint of s and q lies on the line, and s−q is
 * perpendicular to it. Both carry the line's params, so the tie follows a
 * moving mirror line.
 */
function entityAxisRows(l: ResolvedLine): PointPairRows {
  return (s, q) => {
    const d = makeLinePointDeriv();
    const midOnLine: CompiledRow = {
      params: [l.sx, l.sy, l.ex, l.ey, s.ix, s.iy, q.ix, q.iy],
      eval: (p) => {
        linePointSignedDist(p, l, (p[s.ix] + p[q.ix]) / 2, (p[s.iy] + p[q.iy]) / 2, d);
        return d.g;
      },
      jac: (p, out) => {
        linePointSignedDist(p, l, (p[s.ix] + p[q.ix]) / 2, (p[s.iy] + p[q.iy]) / 2, d);
        out[0] = d.dSx;
        out[1] = d.dSy;
        out[2] = d.dEx;
        out[3] = d.dEy;
        out[4] = d.dWx / 2;
        out[5] = d.dWy / 2;
        out[6] = d.dWx / 2;
        out[7] = d.dWy / 2;
      },
    };
    // h = dot(u, s−q)/|u|
    const perpendicular: CompiledRow = {
      params: [l.sx, l.sy, l.ex, l.ey, s.ix, s.iy, q.ix, q.iy],
      eval: (p) => {
        const ux = p[l.ex] - p[l.sx];
        const uy = p[l.ey] - p[l.sy];
        const dx = p[s.ix] - p[q.ix];
        const dy = p[s.iy] - p[q.iy];
        return (ux * dx + uy * dy) / floorDist(Math.hypot(ux, uy));
      },
      jac: (p, out) => {
        const ux = p[l.ex] - p[l.sx];
        const uy = p[l.ey] - p[l.sy];
        const dx = p[s.ix] - p[q.ix];
        const dy = p[s.iy] - p[q.iy];
        const dl = floorDist(Math.hypot(ux, uy));
        const f = ux * dx + uy * dy;
        const d2 = dl * dl;
        out[0] = (-dx * dl + f * (ux / dl)) / d2;
        out[1] = (-dy * dl + f * (uy / dl)) / d2;
        out[2] = (dx * dl - f * (ux / dl)) / d2;
        out[3] = (dy * dl - f * (uy / dl)) / d2;
        out[4] = ux / dl;
        out[5] = uy / dl;
        out[6] = -ux / dl;
        out[7] = -uy / dl;
      },
    };
    return [midOnLine, perpendicular];
  };
}

/**
 * The same two rows across a CONSTANT line (a world axis expressed in
 * sketch coordinates): linear in s and q, constant Jacobian.
 */
function fixedAxisRows(axis: FixedAxisLine): PointPairRows {
  const [ax, ay, bx, by] = axis;
  const ux = bx - ax;
  const uy = by - ay;
  const dl = floorDist(Math.hypot(ux, uy));
  return (s, q) => [
    {
      // cross(u, m − a)/|u| with m the midpoint of s and q.
      params: [s.ix, s.iy, q.ix, q.iy],
      eval: (p) => {
        const mx = (p[s.ix] + p[q.ix]) / 2 - ax;
        const my = (p[s.iy] + p[q.iy]) / 2 - ay;
        return (ux * my - uy * mx) / dl;
      },
      jac: (_p, out) => {
        out[0] = -uy / (2 * dl);
        out[1] = ux / (2 * dl);
        out[2] = -uy / (2 * dl);
        out[3] = ux / (2 * dl);
      },
    },
    {
      // dot(u, s − q)/|u|
      params: [s.ix, s.iy, q.ix, q.iy],
      eval: (p) => (ux * (p[s.ix] - p[q.ix]) + uy * (p[s.iy] - p[q.iy])) / dl,
      jac: (_p, out) => {
        out[0] = ux / dl;
        out[1] = uy / dl;
        out[2] = -ux / dl;
        out[3] = -uy / dl;
      },
    },
  ];
}
