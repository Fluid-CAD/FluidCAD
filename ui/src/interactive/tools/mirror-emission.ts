// The constraint-native sketch Mirror (the Rectangle/Fillet tools' idiom):
// instead of writing a `mirror()` statement, the tool emits the REFLECTED
// geometry as ordinary line/arc/circle/point/bezier statements plus
// `symmetric(source, image, line)` rows, through the atomic insert-solved
// rail. The user ends up with plain, editable geometry held symmetric by
// constraints they can read, move and delete; the hand-written `mirror()`
// command keeps existing for code.

import type { SolvedPick } from '../sketch-hover-select-handler';
import {
  bezierControlPoints, bezierViewForShape, pickForEntity,
  type SolvedBezierView, type SolvedSketchModel,
} from '../../sketch-solver-client';
import type { SceneObjectRender } from '../../types';
import { constraintTargetFor } from '../solved-constraint-toolbar/constraint-targets';
import {
  arcText, bezierText, circleText, ellipseText, lineText, newTarget, pointText,
  type SolvedConstraintParam, type SolvedEmissionRequest, type SolvedEmissionTargetParam,
  type SolvedGeometryParam,
} from './solved-emission';

type V2 = [number, number];

/** The mirror line: one of the sketch's datum axes, or a picked sketched line. */
export type MirrorAxisInput =
  | { kind: 'datum'; axis: 'x' | 'y' }
  | { kind: 'pick'; pick: SolvedPick };

/**
 * One picked shape to mirror: a solver entity's edge pick, or a bezier
 * curve — no solver entity itself, but a rigid function of its control
 * points, each a solver point (its own anchor, or another entity's point).
 */
export type MirrorTarget =
  | { pick: SolvedPick }
  | { bezier: SolvedBezierView };

export type MirrorEmissionPlan = {
  ok: true;
  /** Mirrored entities, in pick order. */
  count: number;
  request: SolvedEmissionRequest;
  /** The geometry statements about to be written, one per line. */
  preview: string[];
};

export type MirrorEmissionError = { ok: false; reason: string };

const fail = (reason: string): MirrorEmissionError => ({ ok: false, reason });
const p2 = (p: V2): V2 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

/**
 * An ellipse's RX-axis angle reflected across the line through a and b,
 * in DEGREES for the statement: a direction at θ reflects to 2φ − θ, φ the
 * line's angle. Normalized to (−180, 180].
 */
export function reflectAngleDeg(thetaRad: number, a: V2, b: V2): number {
  const phi = Math.atan2(b[1] - a[1], b[0] - a[0]);
  let deg = ((2 * phi - thetaRad) * 180) / Math.PI;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  return deg === -180 ? 180 : deg;
}

/** p reflected across the infinite line through a and b. */
export function reflectPoint(p: V2, a: V2, b: V2): V2 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const len2 = ux * ux + uy * uy;
  const dx = p[0] - a[0];
  const dy = p[1] - a[1];
  const t = (dx * ux + dy * uy) / len2;
  const fx = a[0] + t * ux;
  const fy = a[1] + t * uy;
  return [2 * fx - p[0], 2 * fy - p[1]];
}

function isGuideObj(obj: SceneObjectRender | undefined): boolean {
  return (obj?.sceneShapes ?? []).some(shape => shape.isGuide === true);
}

/**
 * Resolve the dialog's picked shape ids, in pick order, to mirror targets:
 * an entity's edge pick (never a vertex pick — those name nothing
 * mirrorable), or the bezier statement whose curve was picked. Shapes that
 * resolve to neither — an offset edge, a text glyph, an unrendered sketch —
 * come back in `unresolved`, so the dialog refuses by name instead of
 * silently mirroring less than what was picked.
 */
export function mirrorTargetsFor(
  shapeIds: string[],
  picks: SolvedPick[],
  model: SolvedSketchModel | null,
): { targets: MirrorTarget[]; unresolved: string[] } {
  const targets: MirrorTarget[] = [];
  const unresolved: string[] = [];
  for (const shapeId of shapeIds) {
    const pick = picks.find(p => p.shapeId === shapeId && p.role === undefined);
    if (pick) {
      targets.push({ pick });
      continue;
    }
    const bezier = model ? bezierViewForShape(model, shapeId) : undefined;
    if (bezier) {
      targets.push({ bezier });
      continue;
    }
    unresolved.push(shapeId);
  }
  return { targets, unresolved };
}

/**
 * The constraint target naming control point `index` of a bezier — the
 * solver point it rides: the statement's own anchor for a literal
 * argument (`bz.point(i)`), or the owner entity's point for an
 * accessor-valued one (`l.end()`). A string is the refusal.
 */
function bezierPointSource(
  model: SolvedSketchModel,
  view: SolvedBezierView,
  index: number,
): SolvedEmissionTargetParam | string {
  const source = view.sources[index];
  const entity = source ? model.entities.get(source.entityId) : undefined;
  if (!source || !entity) {
    return `control point ${index + 1} of the bezier has no solver identity — mirror it with mirror() in code`;
  }
  if (source.role === 'mid') {
    return `control point ${index + 1} of the bezier rides a line midpoint, which symmetric() cannot name`;
  }
  return constraintTargetFor(pickForEntity(model, entity, source.role));
}

/**
 * Plan the mirror for the current targets: each must be a drawn
 * line/arc/circle/point with solved geometry or a bezier with solved
 * control points, and the mirror line a datum axis or a picked line
 * entity. Refuses with a reason the dialog shows.
 */
export function buildMirrorEmission(opts: {
  targets: MirrorTarget[];
  model: SolvedSketchModel;
  axis: MirrorAxisInput;
}): MirrorEmissionPlan | MirrorEmissionError {
  const { model } = opts;

  // The mirror line as geometry (for the reflected guesses) and as the
  // constraint target the symmetric rows name.
  let axisA: V2;
  let axisB: V2;
  let axisTarget: SolvedEmissionTargetParam;
  let axisEntityId: number | null = null;
  if (opts.axis.kind === 'datum') {
    axisA = [0, 0];
    axisB = opts.axis.axis === 'x' ? [1, 0] : [0, 1];
    axisTarget = { datum: opts.axis.axis === 'x' ? 'x-axis' : 'y-axis' };
  } else {
    const pick = opts.axis.pick;
    const view = model.entities.get(pick.entityId);
    if (!view || view.kind !== 'line' || !view.start || !view.end) {
      return fail('the mirror line must be a sketched line — pick a line or one of the sketch axes');
    }
    axisA = view.start;
    axisB = view.end;
    axisEntityId = view.entityId;
    axisTarget = constraintTargetFor({ ...pick, role: undefined });
  }
  if (Math.hypot(axisB[0] - axisA[0], axisB[1] - axisA[1]) < 1e-9) {
    return fail('the mirror line has no length');
  }
  const reflect = (p: V2): V2 => p2(reflectPoint(p, axisA, axisB));

  const geometry: SolvedGeometryParam[] = [];
  const constraints: SolvedConstraintParam[] = [];
  const preview: string[] = [];
  const seenEntities = new Set<number>();
  const seenBeziers = new Set<SolvedBezierView>();
  for (const target of opts.targets) {
    if ('bezier' in target) {
      const view = target.bezier;
      if (seenBeziers.has(view)) {
        continue;
      }
      seenBeziers.add(view);
      const points = bezierControlPoints(model, view);
      if (points.length < 2) {
        return fail('a picked bezier has a single control point — finish drawing it first');
      }
      const k = geometry.length;
      const text = bezierText(points.map(reflect));
      const guide = isGuideObj(view.obj);
      // The curve is a rigid function of its control points, so mirroring
      // every control point mirrors the curve exactly: one point-pair
      // symmetric per control point (2 rows each — the image's 2n params).
      for (let i = 0; i < points.length; i++) {
        const source = bezierPointSource(model, view, i);
        if (typeof source === 'string') {
          return fail(source);
        }
        constraints.push({
          kind: 'symmetric',
          targets: [source, { newIndex: k, featureType: 'bezier', pointIndex: i }, axisTarget],
        });
      }
      geometry.push({ kind: 'bezier', text, ...(guide ? { guide: true } : {}) });
      preview.push(`${text}${guide ? '.guide()' : ''}`);
      continue;
    }
    const pick = target.pick;
    if (pick.role !== undefined || pick.datum !== undefined || seenEntities.has(pick.entityId)) {
      continue;
    }
    seenEntities.add(pick.entityId);
    if (pick.entityId === axisEntityId) {
      return fail('the mirror line cannot be mirrored across itself — remove it from Geometry');
    }
    if (pick.anchor !== undefined) {
      return fail(`the Mirror tool mirrors lines, arcs, circles, ellipses, beziers and points — a ${pick.anchor.owner} needs mirror() in code`);
    }
    const view = model.entities.get(pick.entityId);
    if (!view) {
      return fail('a picked edge has no solver geometry — the sketch has not rendered yet');
    }
    const k = geometry.length;
    const source = constraintTargetFor({ ...pick, role: undefined });
    const guide = isGuideObj(view.obj);
    let text: string;
    switch (view.kind) {
      case 'line': {
        if (!view.start || !view.end) {
          return fail('a picked line has no solved endpoints');
        }
        text = lineText(reflect(view.start), reflect(view.end));
        break;
      }
      case 'arc': {
        if (!view.start || !view.end || !view.center) {
          return fail('a picked arc has no solved geometry');
        }
        // A reflection flips the sweep: the image runs the other way round.
        text = arcText(reflect(view.start), reflect(view.end), reflect(view.center), !(view.cw ?? false));
        break;
      }
      case 'circle': {
        if (!view.center || view.radius === undefined) {
          return fail('a picked circle has no solved geometry');
        }
        text = circleText(reflect(view.center), 2 * view.radius);
        break;
      }
      case 'point': {
        if (!view.point) {
          return fail('a picked point has no solved position');
        }
        text = pointText(reflect(view.point));
        break;
      }
      case 'ellipse': {
        if (!view.center || !view.radii || view.theta === undefined) {
          return fail('a picked ellipse has no solved geometry');
        }
        // The image keeps the semi-radii and reflects the RX axis; the
        // rotation is written so the solver's linear orientation row starts
        // on the right branch.
        text = ellipseText(reflect(view.center), view.radii[0], view.radii[1], reflectAngleDeg(view.theta, axisA, axisB));
        break;
      }
    }
    geometry.push({ kind: view.kind, text, ...(guide ? { guide: true } : {}) });
    preview.push(`${text}${guide ? '.guide()' : ''}`);
    // One entity-level symmetric per image: lines mirror both endpoints,
    // circles their centers + equal radii, arcs centers/starts/end rays,
    // ellipses centers + equal semi-radii + reflected RX axes — exact rows,
    // so a mirrored entity never shows up redundant.
    constraints.push({ kind: 'symmetric', targets: [source, newTarget(k), axisTarget] });
  }
  if (geometry.length === 0) {
    return fail('pick sketch edges to mirror — lines, arcs, circles, ellipses, beziers or points');
  }
  return {
    ok: true,
    count: geometry.length,
    request: { geometry, constraints },
    preview,
  };
}
