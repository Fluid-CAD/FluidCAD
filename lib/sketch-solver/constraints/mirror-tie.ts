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
//   ellipse [cx,cy,rx,ry,θ]      → 5 rows: center reflected + both radii
//                                   equal + the RX axis direction reflected
//                                   (cross(u_t, reflect(u_s)) = 0,
//                                   π-periodic like the ellipse)

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedEllipse, ResolvedLine, ResolvedPoint } from './types.js';
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
    case 'ellipse': {
      const es = ctx.ellipse({ entity: spec.source }, 'mirror-tie source');
      const et = ctx.ellipse({ entity: spec.target }, 'mirror-tie target');
      return [
        ...pointRows(
          ctx.point(center(spec.source), 'mirror-tie source center'),
          ctx.point(center(spec.target), 'mirror-tie target center'),
        ),
        equalRow(et.rx, es.rx),
        equalRow(et.ry, es.ry),
        ellipseAxisRow(es, et, Array.isArray(spec.axis) ? spec.axis : ctx.line(spec.axis, 'mirror-tie axis')),
      ];
    }
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

/** target = source — a reflection is an isometry, radii ride along. */
function equalRow(target: number, source: number): CompiledRow {
  return {
    params: [target, source],
    eval: (p) => p[target] - p[source],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -1;
    },
  };
}

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

/**
 * The target's RX axis u_t is the source axis reflected across the mirror
 * line's direction â: r = 2(u_s·â)â − u_s, residual cross(u_t, r) = 0
 * (dimensionless; r is a unit vector, and parallel / anti-parallel both
 * name the same ellipse). Across a solver line the row also carries the
 * line's params through â = (e−s)/|e−s|.
 */
function ellipseAxisRow(
  s: ResolvedEllipse,
  t: ResolvedEllipse,
  axis: ResolvedLine | FixedAxisLine,
): CompiledRow {
  const fixed = Array.isArray(axis);
  const params = fixed
    ? [t.th, s.th]
    : [t.th, s.th, axis.sx, axis.sy, axis.ex, axis.ey];
  const dir = (p: Float64Array): { ax: number; ay: number; len: number } => {
    const lx = fixed ? axis[2] - axis[0] : p[axis.ex] - p[axis.sx];
    const ly = fixed ? axis[3] - axis[1] : p[axis.ey] - p[axis.sy];
    const len = floorDist(Math.hypot(lx, ly));
    return { ax: lx / len, ay: ly / len, len };
  };
  return {
    params,
    eval: (p) => {
      const { ax, ay } = dir(p);
      const usx = Math.cos(p[s.th]);
      const usy = Math.sin(p[s.th]);
      const dot = usx * ax + usy * ay;
      const rxv = 2 * dot * ax - usx;
      const ryv = 2 * dot * ay - usy;
      const utx = Math.cos(p[t.th]);
      const uty = Math.sin(p[t.th]);
      return utx * ryv - uty * rxv;
    },
    jac: (p, out) => {
      const { ax, ay, len } = dir(p);
      const usx = Math.cos(p[s.th]);
      const usy = Math.sin(p[s.th]);
      const dot = usx * ax + usy * ay;
      const rxv = 2 * dot * ax - usx;
      const ryv = 2 * dot * ay - usy;
      const utx = Math.cos(p[t.th]);
      const uty = Math.sin(p[t.th]);
      // ∂/∂θ_t through u_t' = (−uty, utx).
      out[0] = -uty * ryv - utx * rxv;
      // ∂h/∂r = (−uty, utx); ∂r/∂θ_s = 2(v_s·â)â − v_s, v_s = (−usy, usx).
      const hrx = -uty;
      const hry = utx;
      const vdot = -usy * ax + usx * ay;
      out[1] = hrx * (2 * vdot * ax + usy) + hry * (2 * vdot * ay - usx);
      if (!fixed) {
        // ∂r_i/∂â_j = 2·u_j·â_i + 2·(u·â)·δ_ij, chained through
        // ∂â/∂L = (I − â âᵀ)/|L|; ∂/∂e = ∂/∂L, ∂/∂s = −∂/∂L.
        const hr_a = hrx * ax + hry * ay;
        const qx = 2 * usx * hr_a + 2 * dot * hrx;
        const qy = 2 * usy * hr_a + 2 * dot * hry;
        const qa = qx * ax + qy * ay;
        const lx = (qx - qa * ax) / len;
        const ly = (qy - qa * ay) / len;
        out[2] = -lx;
        out[3] = -ly;
        out[4] = lx;
        out[5] = ly;
      }
    },
  };
}
