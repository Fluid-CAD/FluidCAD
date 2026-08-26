// Constraint glyph layout (sketch-rewrite P3): one pure pass from the read
// model to drawable/hit-testable descriptors in sketch-local 2D. The mesh
// layer (solved-constraint meshes) and the badge hit index both consume
// these, so what is drawn is exactly what is pickable.

import type { ConstraintSpec } from '../../../lib/sketch-solver/types.js';
import type { SourceLocation } from '../types';
import type { DimensionStyle } from './declutter';
import type { SolvedConstraintView, SolvedEntityView, SolvedSketchModel } from './model';
import { specEntityIds } from './model';
import { diameterChord } from './diameter-chord';
import {
  Vec2,
  alongDirAt,
  dist,
  entityAnchor,
  entityFor,
  entitySpan,
  footOnLine,
  lineDir,
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
  segmentRidesEntityLine,
  sketchCentroid,
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

/** Which ends of a dimension leader carry an arrowhead: `both` for a
 * measured span (a distance, a diameter chord), `end` for a leader that
 * only lands on one thing — a radius runs OUT of its center, which is not
 * a measured point. */
export type ArrowEnds = 'both' | 'end';

export type ConstraintGlyph = GlyphBase & (
  /** Boxed-letter badge, screen-constant. `offsetDir` is the outward normal
   * it floats along, `alongDir` the edge tangent a group of them rows up
   * against; the screen-space declutterer picks the final slot from those
   * two axes (see declutter/). */
  | {
      type: 'badge';
      label: string;
      at: Vec2;
      offsetDir: Vec2;
      alongDir: Vec2;
      /** Host edge length in sketch units — the row's space budget once the
       * view scale turns it into pixels. 0 = no host edge. */
      span: number;
      /** Survival order inside a crowded row — low keeps its slot. */
      rank: number;
    }
  /** Coincidence ring centered on the shared point. */
  | { type: 'dot'; at: Vec2 }
  /** Box-less dimension readout. `offsetDir` pushes it clear of the
   * dimension line, `alongDir` is the axis it may slide along, and
   * `slideRange` how far (sketch units, one way). `style` picks which slide
   * stops the declutterer offers it; `leader` carries the dimension line so
   * a pushed-out label can draw a link back to it. */
  | {
      type: 'text';
      label: string;
      at: Vec2;
      offsetDir: Vec2;
      alongDir: Vec2;
      style: DimensionStyle;
      slideRange: number;
      leader?: [Vec2, Vec2];
    }
  /** World-scale dimension leader line. `extensions` are dashed witness
   * leaders from a synthetic leader end to the real anchor it measures
   * (axis-locked distances draw the leader axis-aligned, so the far point
   * can float off it — the angle glyph's extension convention).
   * `arrows` caps the ends with screen-constant drafting arrowheads. */
  | {
      type: 'leader';
      from: Vec2;
      to: Vec2;
      extensions?: [Vec2, Vec2][];
      arrows?: ArrowEnds;
    }
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

/**
 * Which badges keep their slot when a row overflows into a `+N` pill.
 *
 * The rule is "how much does the picture already tell you?". A horizontal
 * line looks horizontal, so its H badge is the cheapest thing to collapse; a
 * tangency, a fix or a symmetry is invisible in the geometry and has to stay
 * on screen. Ties fall back to statement order, so the surviving set is
 * stable across zoom steps rather than reshuffling every frame.
 */
const BADGE_RANK: Record<string, number> = {
  fix: 0,
  tangent: 1,
  symmetric: 2,
  perpendicular: 3,
  parallel: 4,
  collinear: 5,
  concentric: 6,
  equal: 7,
  midpoint: 8,
  'point-on': 9,
  horizontal: 10,
  vertical: 10,
};

const DEFAULT_BADGE_RANK = 5;

export function formatDim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function statusColor(c: SolvedConstraintView): GlyphColorRole {
  if (c.status === 'conflicting') {
    return 'conflict';
  }
  return c.status === 'redundant' ? 'redundant' : 'normal';
}

/**
 * Layout the glyphs for every constraint statement of a solved sketch.
 *
 * This pass is camera-free: it fixes each glyph's ANCHOR and its two local
 * axes (outward normal + edge tangent) in sketch coordinates. Where a glyph
 * actually lands on screen — how far out, which side, whether it collapses
 * into a `+N` pill — is decided per zoom step by the declutterer, which is
 * the only thing that knows how many pixels there are to spend.
 */
export function layoutConstraintGlyphs(model: SolvedSketchModel): ConstraintGlyph[] {
  const glyphs: ConstraintGlyph[] = [];
  const drawnDots = new Set<string>();
  const centroid = sketchCentroid(model);

  const stackKey = (at: Vec2): string => `${Math.round(at[0] * 1e3)},${Math.round(at[1] * 1e3)}`;

  for (const c of model.constraints) {
    const base: GlyphBase = {
      color: statusColor(c),
      objId: c.obj.id,
      sourceLocation: c.obj.sourceLocation,
      refEntityIds: specEntityIds(c.spec),
    };

    /** `kind` keys both the glyph letter and its overflow rank; `on` is the
     * entity the badge rides, which fixes its outward/tangent axes. */
    const badge = (
      kind: string,
      at: Vec2 | null,
      on?: SolvedEntityView,
      axes?: { out: Vec2; along: Vec2; span: number },
    ): void => {
      if (!at) {
        return;
      }
      glyphs.push({
        ...base,
        type: 'badge',
        label: BADGE_LABELS[kind] ?? kind,
        at,
        offsetDir: axes?.out ?? offsetDirAt(on, at, centroid),
        alongDir: axes?.along ?? alongDirAt(on, at),
        span: axes?.span ?? entitySpan(on),
        rank: BADGE_RANK[kind] ?? DEFAULT_BADGE_RANK,
      });
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
            badge('point-on', point, entityFor(model, targetRef));
          }
        }
        break;
      }

      case 'horizontal':
      case 'vertical': {
        if (spec.b) {
          const pa = refPoint(model, spec.a);
          // Every point after the first pairs with it — one badge per
          // pair, at the pair's midpoint.
          for (const ref of [spec.b, ...(spec.others ?? [])]) {
            const pb = refPoint(model, ref);
            if (pa && pb) {
              // A point-pair H/V has no owning entity — the pair itself is
              // the edge, so it supplies the row axis and budget directly.
              const dir = normalize(sub(pb, pa));
              badge(spec.kind, mid(pa, pb), undefined, {
                out: perp(dir), along: dir, span: dist(pa, pb),
              });
            }
          }
        } else {
          const e = entityFor(model, spec.a);
          if (e) {
            badge(spec.kind, entityAnchor(e), e);
          }
        }
        break;
      }

      case 'parallel':
      case 'perpendicular':
      case 'equal':
      case 'collinear': {
        const others = spec.kind === 'equal' || spec.kind === 'parallel' ? spec.others ?? [] : [];
        for (const ref of [spec.a, spec.b, ...others]) {
          const e = entityFor(model, ref);
          if (e) {
            badge(spec.kind, entityAnchor(e), e);
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
            badge('tangent', at, round);
          }
        }
        break;
      }

      case 'concentric': {
        const e = entityFor(model, spec.a) ?? entityFor(model, spec.b);
        badge('concentric', e?.center ?? null);
        break;
      }

      case 'midpoint': {
        const at = refPoint(model, spec.p);
        badge('midpoint', at, entityFor(model, spec.l));
        break;
      }

      case 'symmetric': {
        for (const ref of [spec.a, spec.b]) {
          badge('symmetric', refPoint(model, ref));
        }
        break;
      }

      case 'fix': {
        badge('fix', refPoint(model, spec.p));
        break;
      }

      case 'distance': {
        const layout = distanceLeaderLayout(model, spec);
        if (layout) {
          const { from, to, extensions } = layout;
          const dir = normalize(sub(to, from));
          glyphs.push({
            ...base, type: 'leader', from, to, arrows: 'both',
            ...(extensions.length > 0 ? { extensions } : {}),
          });
          glyphs.push({
            ...base,
            type: 'text',
            label: formatDim(c.value ?? spec.value),
            at: mid(from, to),
            // Push clear of the dimension line, slide along it — the label
            // stays ON its own dimension wherever the declutterer parks it.
            offsetDir: perp(dir),
            alongDir: dir,
            style: 'span',
            slideRange: dist(from, to) / 2,
            leader: [from, to],
          });
        }
        break;
      }

      case 'radius': {
        const e = entityFor(model, spec.a);
        if (e && e.center) {
          const rim = entityAnchor(e);
          if (rim) {
            // Rim end only: the leader runs OUT of the center, which is
            // not one of the two ends of a measured span.
            glyphs.push({ ...base, type: 'leader', from: e.center, to: rim, arrows: 'end' });
            const dir = normalize(sub(rim, e.center));
            glyphs.push({
              ...base,
              type: 'text',
              label: `R${formatDim(c.value ?? spec.value)}`,
              at: mid(e.center, rim),
              // The value rides the radius like a diameter rides its chord:
              // laid ALONG the line, centered between center and rim, one
              // gap clear. Orbiting the rim instead needs a stub to say
              // which line the number belongs to; sitting on the line says
              // it outright.
              offsetDir: perp(dir),
              alongDir: dir,
              style: 'aligned',
              slideRange: (e.radius ?? 0) / 2,
              leader: [e.center, rim],
            });
          }
        }
        break;
      }

      case 'diameter': {
        const e = entityFor(model, spec.a);
        if (e) {
          // Rim to rim through the center: a leader that stops at the
          // center is a radius, whatever the label says.
          const chord = diameterChord(model, e);
          if (chord) {
            const [from, to] = chord;
            const dir = normalize(sub(to, from));
            // Both rims: the chord IS the measured span, so it is capped
            // like a distance (a radius' center end gets no arrow).
            glyphs.push({ ...base, type: 'leader', from, to, arrows: 'both' });
            glyphs.push({
              ...base,
              type: 'text',
              label: `⌀${formatDim(c.value ?? spec.value)}`,
              at: mid(from, to),
              // The value rides the chord: laid ALONG it (the sprite layer
              // rolls an `aligned` label to its line), centered on it, one gap
              // clear — so it reads as this circle's size from inside the
              // circle instead of orbiting the rim like a radius readout.
              // The `leader` names the line it owns; a centered, aligned
              // value draws no link stub back to it.
              offsetDir: perp(dir),
              alongDir: dir,
              style: 'aligned',
              slideRange: e.radius ?? 0,
              leader: [from, to],
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
              const dir = lineDir(a) ?? [1, 0];
              glyphs.push({
                ...base,
                type: 'text',
                label,
                at: mid(ma, mb),
                offsetDir: perp(dir),
                alongDir: dir,
                style: 'span',
                slideRange: 0,
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

/** `p` reflected across `c` — probes the FAR side of a circumference
 * for max-tangency dimensions. */
function mirrorAcross(c: Vec2, p: Vec2): Vec2 {
  return [2 * c[0] - p[0], 2 * c[1] - p[1]];
}

/** Standoff for a leader lifted off collinear geometry, as a fraction of
 * the measured span — world-scale like the leader itself, so the picture
 * zooms as one drawing. */
const LIFTED_LEADER_FRACTION = 0.12;

export type DistanceLeaderLayout = {
  from: Vec2;
  to: Vec2;
  /** Dashed witness leaders from real anchors the leader doesn't touch. */
  extensions: [Vec2, Vec2][];
  /** The leader was lifted off a straight edge it lay along. */
  lifted: boolean;
};

/**
 * The dimension line a distance constraint draws, shared with the toolbar's
 * preview (P4.5) so the preview lands exactly where the committed glyph's
 * leader will.
 *
 * A span whose two anchors lie ON a straight edge (the endpoints of a line,
 * an axis-locked run along one) would draw its leader exactly on top of
 * that edge — arrows, value and all. Drafting lifts such a dimension line
 * parallel to the span and ties each end back to its real anchor with a
 * dashed witness leader; the side faces away from the sketch's centroid,
 * like the badges' outward normals.
 */
export function distanceLeaderLayout(
  model: SolvedSketchModel,
  spec: Extract<ConstraintSpec, { kind: 'distance' }>,
): DistanceLeaderLayout | null {
  const points = distanceSpecEndpoints(model, spec);
  if (!points) {
    return null;
  }
  const [from, to] = points;
  const extensions = distanceSpecExtensions(model, spec);
  const span = dist(from, to);
  if (span < 1e-9 || !segmentRidesEntityLine(model, from, to)) {
    return { from, to, extensions, lifted: false };
  }
  const n = perp(normalize(sub(to, from)));
  const centroid = sketchCentroid(model);
  const m = mid(from, to);
  const side = centroid
    && n[0] * (m[0] - centroid[0]) + n[1] * (m[1] - centroid[1]) < 0 ? -1 : 1;
  const d = span * LIFTED_LEADER_FRACTION * side;
  const liftedFrom: Vec2 = [from[0] + n[0] * d, from[1] + n[1] * d];
  const liftedTo: Vec2 = [to[0] + n[0] * d, to[1] + n[1] * d];
  // The witnesses tie each lifted end to the REAL anchor it measures — for
  // an axis-locked span the far end is a synthetic corner whose anchor is
  // the actual second point (distanceSpecExtensions' convention).
  const realTo = extensions.length > 0 ? extensions[0][1] : to;
  return {
    from: liftedFrom,
    to: liftedTo,
    extensions: [[from, liftedFrom], [realTo, liftedTo]],
    lifted: true,
  };
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
