// Constraint glyph layout (sketch-rewrite P3): one pure pass from the read
// model to drawable/hit-testable descriptors in sketch-local 2D. The mesh
// layer (solved-constraint meshes) and the badge hit index both consume
// these, so what is drawn is exactly what is pickable.

import type { ConstraintSpec } from '../../../lib/sketch-solver/types.js';
import type { SourceLocation } from '../types';
import type { SolvedConstraintView, SolvedSketchModel } from './model';
import { specEntityIds } from './model';
import {
  Vec2,
  entityAnchor,
  entityFor,
  footOnLine,
  lineIntersection,
  lineMid,
  mid,
  normalize,
  offsetDirAt,
  orientedLineDir,
  perp,
  pointOnCircumference,
  refAnchor,
  refPoint,
  segmentCoversRay,
  segmentExtensionTo,
  sub,
  tangencyPoint,
} from './resolve';

export type GlyphColorRole = 'normal' | 'redundant' | 'conflict';

type GlyphBase = {
  color: GlyphColorRole;
  /** Scene object id of the owning constraint statement. */
  objId?: string;
  sourceLocation?: SourceLocation;
  /** Entities the constraint references — hover highlights these. */
  refEntityIds: number[];
};

export type ConstraintGlyph = GlyphBase & (
  /** Boxed-letter badge, screen-constant, offset from `at` along
   * `offsetDir` (stacked badges shift further out). */
  | { type: 'badge'; label: string; at: Vec2; offsetDir: Vec2; stackIndex: number }
  /** Coincidence ring centered on the shared point. */
  | { type: 'dot'; at: Vec2 }
  /** Box-less dimension readout, offset like a badge. */
  | { type: 'text'; label: string; at: Vec2; offsetDir: Vec2; stackIndex: number }
  /** World-scale dimension leader line. `extensions` are dashed witness
   * leaders from a synthetic leader end to the real anchor it measures
   * (axis-locked distances draw the leader axis-aligned, so the far point
   * can float off it — the angle glyph's extension convention). */
  | { type: 'leader'; from: Vec2; to: Vec2; extensions?: [Vec2, Vec2][] }
  /** Angle dimension: arc swept from `startAngle` by `sweep` around `at`,
   * with the readout at mid-arc. `extensions` are dashed helper leaders
   * from each segment's nearest endpoint to a virtual intersection the
   * segments don't reach (empty when both cross `at`); `tails` are the
   * ray angles whose sector boundary no segment covers — the arc's ends
   * touch a screen-constant dashed stub drawn through the center there. */
  | {
      type: 'angle-arc';
      at: Vec2;
      startAngle: number;
      sweep: number;
      label: string;
      extensions: [Vec2, Vec2][];
      tails: number[];
    }
);

export const BADGE_LABELS: Record<string, string> = {
  horizontal: 'H',
  vertical: 'V',
  tangent: 'T',
  parallel: '∥',
  perpendicular: '⊥',
  equal: '=',
  concentric: '◎',
  collinear: '≡',
  midpoint: 'M',
  symmetric: 'S',
  fix: 'F',
  'point-on': '⊙',
};

export function formatDim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function statusColor(c: SolvedConstraintView): GlyphColorRole {
  if (c.status === 'conflicting') {
    return 'conflict';
  }
  return c.status === 'redundant' ? 'redundant' : 'normal';
}

/** Layout the glyphs for every constraint statement of a solved sketch.
 * Badges sharing an anchor get increasing stack indices so they fan out
 * instead of overdrawing. */
export function layoutConstraintGlyphs(model: SolvedSketchModel): ConstraintGlyph[] {
  const glyphs: ConstraintGlyph[] = [];
  const stackCounts = new Map<string, number>();
  const drawnDots = new Set<string>();

  const stackKey = (at: Vec2): string => `${Math.round(at[0] * 1e3)},${Math.round(at[1] * 1e3)}`;

  const nextStack = (at: Vec2): number => {
    const key = stackKey(at);
    const index = stackCounts.get(key) ?? 0;
    stackCounts.set(key, index + 1);
    return index;
  };

  for (const c of model.constraints) {
    const base: GlyphBase = {
      color: statusColor(c),
      objId: c.obj.id,
      sourceLocation: c.obj.sourceLocation,
      refEntityIds: specEntityIds(c.spec),
    };

    const badge = (label: string, at: Vec2 | null, offsetDir: Vec2 = [0, 1]): void => {
      if (at) {
        glyphs.push({ ...base, type: 'badge', label, at, offsetDir, stackIndex: nextStack(at) });
      }
    };

    const spec = c.spec;
    switch (spec.kind) {
      case 'coincident': {
        const pa = refPoint(model, spec.a);
        const pb = refPoint(model, spec.b);
        if (pa && pb) {
          // Point–point: one ring on the shared spot (midpoint while the
          // guesses still disagree). Identical rings collapse to one drawn
          // glyph.
          const at = mid(pa, pb);
          const key = `${stackKey(at)}|${base.color}`;
          if (!drawnDots.has(key)) {
            drawnDots.add(key);
            glyphs.push({ ...base, type: 'dot', at });
          }
        } else {
          // Point-on-entity: badge at the point, pushed off the target.
          const point = pa ?? pb;
          const targetRef = pa ? spec.b : spec.a;
          if (point) {
            badge(BADGE_LABELS['point-on'], point, offsetDirAt(entityFor(model, targetRef), point));
          }
        }
        break;
      }

      case 'horizontal':
      case 'vertical': {
        const label = BADGE_LABELS[spec.kind];
        if (spec.b) {
          const pa = refPoint(model, spec.a);
          const pb = refPoint(model, spec.b);
          if (pa && pb) {
            const dir = normalize(sub(pb, pa));
            badge(label, mid(pa, pb), perp(dir));
          }
        } else {
          const e = entityFor(model, spec.a);
          if (e) {
            badge(label, entityAnchor(e), offsetDirAt(e, entityAnchor(e) ?? [0, 0]));
          }
        }
        break;
      }

      case 'parallel':
      case 'perpendicular':
      case 'equal':
      case 'collinear': {
        const label = BADGE_LABELS[spec.kind];
        for (const ref of [spec.a, spec.b]) {
          const e = entityFor(model, ref);
          if (e) {
            const at = entityAnchor(e);
            if (at) {
              badge(label, at, offsetDirAt(e, at));
            }
          }
        }
        break;
      }

      case 'tangent': {
        const a = entityFor(model, spec.a);
        const b = entityFor(model, spec.b);
        if (a && b) {
          const at = tangencyPoint(a, b);
          if (at) {
            const round = a.kind === 'circle' || a.kind === 'arc' ? a : b;
            badge(BADGE_LABELS.tangent, at, offsetDirAt(round, at));
          }
        }
        break;
      }

      case 'concentric': {
        const at = entityFor(model, spec.a)?.center ?? entityFor(model, spec.b)?.center ?? null;
        badge(BADGE_LABELS.concentric, at);
        break;
      }

      case 'midpoint': {
        const at = refPoint(model, spec.p);
        const line = entityFor(model, spec.l);
        if (at) {
          badge(BADGE_LABELS.midpoint, at, line ? offsetDirAt(line, at) : [0, 1]);
        }
        break;
      }

      case 'symmetric': {
        for (const ref of [spec.a, spec.b]) {
          const at = refPoint(model, ref);
          if (at) {
            badge(BADGE_LABELS.symmetric, at);
          }
        }
        break;
      }

      case 'fix': {
        const at = refPoint(model, spec.p);
        badge(BADGE_LABELS.fix, at);
        break;
      }

      case 'distance': {
        const points = distanceSpecEndpoints(model, spec);
        if (points) {
          const [from, to] = points;
          const dir = normalize(sub(to, from));
          const offsetDir = perp(dir);
          const extensions = distanceSpecExtensions(model, spec);
          glyphs.push({
            ...base, type: 'leader', from, to,
            ...(extensions.length > 0 ? { extensions } : {}),
          });
          const at = mid(from, to);
          glyphs.push({
            ...base,
            type: 'text',
            label: formatDim(c.value ?? spec.value),
            at,
            offsetDir,
            stackIndex: nextStack(at),
          });
        }
        break;
      }

      case 'radius':
      case 'diameter': {
        const e = entityFor(model, spec.a);
        if (e && e.center) {
          const rim = entityAnchor(e);
          if (rim) {
            const prefix = spec.kind === 'radius' ? 'R' : '⌀';
            glyphs.push({ ...base, type: 'leader', from: e.center, to: rim });
            glyphs.push({
              ...base,
              type: 'text',
              label: `${prefix}${formatDim(c.value ?? spec.value)}`,
              at: rim,
              offsetDir: offsetDirAt(e, rim),
              stackIndex: nextStack(rim),
            });
          }
        }
        break;
      }

      case 'angle': {
        const a = entityFor(model, spec.a);
        const b = entityFor(model, spec.b);
        if (a && b) {
          const at = lineIntersection(a, b);
          const label = `${formatDim(c.value ?? (spec.value * 180) / Math.PI)}°`;
          // The refs orient their lines ('start' reverses) — the arc sweeps
          // counterclockwise from a's ray by the (positive) target, landing
          // in exactly the sector the statement dimensions.
          const da = orientedLineDir(a, spec.a);
          const db = orientedLineDir(b, spec.b);
          if (at && da && db) {
            const tails: number[] = [];
            if (!segmentCoversRay(a, at, da)) {
              tails.push(Math.atan2(da[1], da[0]));
            }
            if (!segmentCoversRay(b, at, db)) {
              tails.push(Math.atan2(db[1], db[0]));
            }
            glyphs.push({
              ...base,
              type: 'angle-arc',
              at,
              startAngle: Math.atan2(da[1], da[0]),
              sweep: spec.value,
              label,
              extensions: [segmentExtensionTo(a, at), segmentExtensionTo(b, at)]
                .filter((e): e is [Vec2, Vec2] => e !== null),
              tails,
            });
          } else {
            // Near-parallel lines have no usable intersection — fall back
            // to a plain readout between the two lines.
            const ma = lineMid(a);
            const mb = lineMid(b);
            if (ma && mb) {
              const fallbackAt = mid(ma, mb);
              glyphs.push({
                ...base,
                type: 'text',
                label,
                at: fallbackAt,
                offsetDir: [0, 1],
                stackIndex: nextStack(fallbackAt),
              });
            }
          }
        }
        break;
      }
    }
  }

  return glyphs;
}

/** The two anchor points a distance dimension spans, by resolved form.
 * Shared with the toolbar's dimension preview (P4.5) so the preview line
 * lands exactly where the committed glyph's leader will. */
/** `p` reflected across `c` — probes the FAR side of a circumference
 * for max-tangency dimensions. */
function mirrorAcross(c: Vec2, p: Vec2): Vec2 {
  return [2 * c[0] - p[0], 2 * c[1] - p[1]];
}

/**
 * Dashed witness extensions for a distance leader that doesn't reach its
 * real anchors. Axis-locked point pairs measure one component: the leader
 * runs axis-aligned from `a`, so its far end is a synthetic corner —
 * extend from it to the real second point when they differ (the angle
 * glyph's dashed extension-leader convention).
 */
export function distanceSpecExtensions(
  model: SolvedSketchModel,
  spec: Extract<ConstraintSpec, { kind: 'distance' }>,
): [Vec2, Vec2][] {
  if (spec.axis === undefined) {
    return [];
  }
  const pa = refPoint(model, spec.a);
  const pb = refPoint(model, spec.b);
  if (!pa || !pb) {
    return [];
  }
  const corner: Vec2 = spec.axis === 'x' ? [pb[0], pa[1]] : [pa[0], pb[1]];
  const gap = spec.axis === 'x' ? Math.abs(pb[1] - pa[1]) : Math.abs(pb[0] - pa[0]);
  return gap < 1e-9 ? [] : [[corner, pb]];
}

export function distanceSpecEndpoints(
  model: SolvedSketchModel,
  spec: Extract<ConstraintSpec, { kind: 'distance' }>,
): [Vec2, Vec2] | null {
  const far = spec.tangency === 'max';
  const pa = refPoint(model, spec.a);
  const pb = refPoint(model, spec.b);
  if (pa && pb) {
    // Axis-locked point pairs measure one component — draw the leader
    // axis-aligned from a so the label sits on what is actually dimensioned.
    if (spec.axis === 'x') {
      return [pa, [pb[0], pa[1]]];
    }
    if (spec.axis === 'y') {
      return [pa, [pa[0], pb[1]]];
    }
    return [pa, pb];
  }

  const ea = entityFor(model, spec.a);
  const eb = entityFor(model, spec.b);

  // Point–line / point–circle: from the point to its projection.
  const point = pa ?? pb;
  const entity = pa ? eb : ea;
  if (point && entity) {
    if (entity.kind === 'line') {
      const foot = footOnLine(entity, point);
      return foot ? [point, foot] : null;
    }
    if (entity.kind === 'circle' || entity.kind === 'arc') {
      const probe = far && entity.center ? mirrorAcross(entity.center, point) : point;
      const rim = pointOnCircumference(entity, probe);
      return rim ? [point, rim] : null;
    }
  }

  if (ea && eb) {
    // Line–line: from b's midpoint to its foot on a.
    if (ea.kind === 'line' && eb.kind === 'line') {
      const from = lineMid(eb);
      const foot = from ? footOnLine(ea, from) : null;
      return from && foot ? [from, foot] : null;
    }
    // Line–circle/arc: from the rim (near or far side) to the center's
    // foot on the line.
    const lineE = ea.kind === 'line' ? ea : eb.kind === 'line' ? eb : null;
    const roundE = lineE === ea ? eb : ea;
    if (lineE && roundE.center) {
      const foot = footOnLine(lineE, roundE.center);
      const probe = foot && far ? mirrorAcross(roundE.center, foot) : foot;
      const rim = probe ? pointOnCircumference(roundE, probe) : null;
      return foot && rim ? [rim, foot] : null;
    }
    // Circle–circle: between circumferences along the center line —
    // near sides, or the far sides for a max dimension.
    if (ea.center && eb.center) {
      const fromRim = pointOnCircumference(ea, far ? mirrorAcross(ea.center, eb.center) : eb.center);
      const toRim = pointOnCircumference(eb, far ? mirrorAcross(eb.center, ea.center) : ea.center);
      return fromRim && toRim ? [fromRim, toRim] : null;
    }
  }

  const anchorA = refAnchor(model, spec.a);
  const anchorB = refAnchor(model, spec.b);
  return anchorA && anchorB ? [anchorA, anchorB] : null;
}
