// The constraint-native sketch Mirror (the Rectangle/Fillet tools' idiom):
// instead of writing a `mirror()` statement, the tool emits the REFLECTED
// geometry as ordinary line/arc/circle/point statements plus one
// `symmetric(source, image, line)` per mirrored entity, through the atomic
// insert-solved rail. The user ends up with plain, editable geometry held
// symmetric by constraints they can read, move and delete; the hand-written
// `mirror()` command keeps existing for code.

import type { SolvedPick } from '../sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../../sketch-solver-client/model';
import { constraintTargetFor } from '../solved-constraint-toolbar/constraint-targets';
import {
  arcText, circleText, lineText, newTarget, pointText,
  type SolvedConstraintParam, type SolvedEmissionRequest, type SolvedEmissionTargetParam,
  type SolvedGeometryParam,
} from './solved-emission';

type V2 = [number, number];

/** The mirror line: one of the sketch's datum axes, or a picked sketched line. */
export type MirrorAxisInput =
  | { kind: 'datum'; axis: 'x' | 'y' }
  | { kind: 'pick'; pick: SolvedPick };

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

function isGuideView(view: SolvedEntityView): boolean {
  return (view.obj?.sceneShapes ?? []).some(shape => shape.isGuide === true);
}

/**
 * Plan the mirror for the current picks: the edge picks are the entities to
 * mirror (a vertex pick names nothing mirrorable), each must be a drawn
 * line/arc/circle/point with solved geometry, and the mirror line a datum
 * axis or a picked line entity. Refuses with a reason the dialog shows.
 */
export function buildMirrorEmission(opts: {
  picks: SolvedPick[];
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

  const geometry: SolvedGeometryParam[] = [];
  const constraints: SolvedConstraintParam[] = [];
  const preview: string[] = [];
  const seen = new Set<number>();
  for (const pick of opts.picks) {
    if (pick.role !== undefined || pick.datum !== undefined || seen.has(pick.entityId)) {
      continue;
    }
    seen.add(pick.entityId);
    if (pick.entityId === axisEntityId) {
      return fail('the mirror line cannot be mirrored across itself — remove it from Geometry');
    }
    if (pick.anchor !== undefined) {
      return fail(`the Mirror tool mirrors lines, arcs, circles and points — a ${pick.anchor.owner} needs mirror() in code`);
    }
    const view = model.entities.get(pick.entityId);
    if (!view) {
      return fail('a picked edge has no solver geometry — the sketch has not rendered yet');
    }
    const k = geometry.length;
    const source = constraintTargetFor({ ...pick, role: undefined });
    const guide = isGuideView(view);
    let text: string;
    switch (view.kind) {
      case 'line': {
        if (!view.start || !view.end) {
          return fail('a picked line has no solved endpoints');
        }
        text = lineText(p2(reflectPoint(view.start, axisA, axisB)), p2(reflectPoint(view.end, axisA, axisB)));
        break;
      }
      case 'arc': {
        if (!view.start || !view.end || !view.center) {
          return fail('a picked arc has no solved geometry');
        }
        // A reflection flips the sweep: the image runs the other way round.
        text = arcText(
          p2(reflectPoint(view.start, axisA, axisB)),
          p2(reflectPoint(view.end, axisA, axisB)),
          p2(reflectPoint(view.center, axisA, axisB)),
          !(view.cw ?? false),
        );
        break;
      }
      case 'circle': {
        if (!view.center || view.radius === undefined) {
          return fail('a picked circle has no solved geometry');
        }
        text = circleText(p2(reflectPoint(view.center, axisA, axisB)), 2 * view.radius);
        break;
      }
      case 'point': {
        if (!view.point) {
          return fail('a picked point has no solved position');
        }
        text = pointText(p2(reflectPoint(view.point, axisA, axisB)));
        break;
      }
    }
    geometry.push({ kind: view.kind, text, ...(guide ? { guide: true } : {}) });
    preview.push(`${text}${guide ? '.guide()' : ''}`);
    // One entity-level symmetric per image: lines mirror both endpoints,
    // circles their centers + equal radii, arcs centers/starts/end rays —
    // exact rows, so a mirrored arc never shows up redundant.
    constraints.push({ kind: 'symmetric', targets: [source, newTarget(k), axisTarget] });
  }
  if (geometry.length === 0) {
    return fail('pick sketch edges to mirror — lines, arcs, circles or points');
  }
  return {
    ok: true,
    count: geometry.length,
    request: { geometry, constraints },
    preview,
  };
}
