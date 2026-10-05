// repeat request validation (create and edit).

import {
  validCountValue,
  validValueExpr,
  type FeatureStatementEditTarget,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick } from '../picks.ts';
import { validateRevolveAxis, type RevolveAxisInput } from './revolve.ts';
import type { StatementEditRequest } from './statement-edit.ts';

/** The mirror plane of a repeat request: a standard plane, an existing plane feature, or a picked face. */
export type RepeatPlaneInput =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; loc: SketchLoc }
  | { kind: 'face'; pick: Pick };

/** One linear direction: its axis plus that direction's count and value. */
type RepeatDirectionInput = { axis: RevolveAxisInput; count: ValueExpr; value: ValueExpr };

type RepeatRequest = {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** The feature statements being repeated, in argument order. */
  targets: SketchLoc[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: RepeatDirectionInput[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  axis?: RevolveAxisInput;
  plane?: RepeatPlaneInput;
  count?: ValueExpr;
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  centered?: boolean;
  angle?: ValueExpr;
};

export const MAX_REPEAT_TARGETS = 16;

const MAX_REPEAT_DIRECTIONS = 3;

/**
 * The repeat request's shape: the kind, one or more target feature
 * statements addressed by their source locations, plus the kind's inputs —
 * linear directions (each an axis with its own count and value, sharing one
 * offset/length spacing mode), a single axis for circular/rotate (a standard
 * world axis, an existing axis statement, or a picked edge), or a mirror
 * plane (a standard origin plane, an existing plane feature, or a picked
 * face), and the numeric options (count with a sweep for circular, the angle
 * for rotate).
 */
export function validateRepeat(body: any): RepeatRequest | { error: string } {
  const { kind, targets, count, centered, angle } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular' && kind !== 'mirror' && kind !== 'rotate') {
    return { error: 'kind must be "linear", "circular", "mirror" or "rotate"' };
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_REPEAT_TARGETS) {
    return { error: `targets must be 1-${MAX_REPEAT_TARGETS} feature statements to repeat` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the repeat targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  const filePath = targetLocs[0].filePath;

  if (kind === 'mirror') {
    for (const key of ['axis', 'directions', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a mirror repeat takes no ${key}` };
      }
    }
    const raw = body?.plane;
    let plane: RepeatPlaneInput;
    if (raw?.kind === 'standard') {
      if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
        return { error: 'a standard mirror plane must be "xy", "xz" or "yz"' };
      }
      plane = { kind: 'standard', plane: raw.plane };
    } else if (raw?.kind === 'plane') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a plane input must carry the plane {filePath, line}' };
      }
      if (loc.filePath !== filePath) {
        return { error: 'the mirror plane and the targets live in different files' };
      }
      plane = { kind: 'plane', loc };
    } else if (raw?.kind === 'face') {
      const pick = validatePick(raw.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a picked mirror plane must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      plane = { kind: 'face', pick };
    } else {
      return { error: 'plane must be {kind: "standard"|"plane"|"face", …}' };
    }
    return { kind, targets: targetLocs, plane };
  }

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} repeat takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear repeat carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
      }
    }
    if (centered !== undefined && typeof centered !== 'boolean') {
      return { error: 'centered must be a boolean' };
    }
    const spacingMode = body?.spacingMode;
    if (spacingMode !== 'offset' && spacingMode !== 'length') {
      return { error: 'spacingMode must be "offset" or "length"' };
    }
    const raw = body?.directions;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REPEAT_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_REPEAT_DIRECTIONS} axis directions` };
    }
    const directions: RepeatDirectionInput[] = [];
    for (const entry of raw) {
      const axis = validateRevolveAxis(entry?.axis);
      if ('error' in axis) {
        return axis;
      }
      if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
        return { error: 'an axis and the targets live in different files' };
      }
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
      }
      directions.push({ axis, count: entry.count, value: entry.value });
    }
    return { kind, targets: targetLocs, directions, spacingMode, centered: centered === true };
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: `only a linear repeat takes directions` };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear repeat takes a spacingMode' };
  }
  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
    return { error: 'the axis and the targets live in different files' };
  }

  if (kind === 'rotate') {
    for (const key of ['count', 'sweep', 'centered'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a rotate repeat takes no ${key}` };
      }
    }
    if (!validValueExpr(angle, { nonzero: true })) {
      return { error: 'angle must be a nonzero rotation in degrees' };
    }
    return { kind, targets: targetLocs, axis, angle };
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  if (angle !== undefined && angle !== null) {
    return { error: 'a circular repeat carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular repeat takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  return {
    kind, targets: targetLocs, axis, count,
    sweep: { mode: sweep.mode, value: sweep.value },
  };
}

/**
 * One axis slot of an edited repeat as the request carries it: keep the
 * statement's own axis text by position, or any create-mode axis input.
 */
export type RepeatEditAxisInput = { kind: 'keep'; sourceIndex: number } | RevolveAxisInput;

/** One repeat-edit axis field: keep by position, or a create-mode axis. */
export function validateRepeatEditAxis(raw: any): RepeatEditAxisInput | { error: string } {
  if (raw?.kind === 'keep') {
    if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0) {
      return { error: 'a kept axis must carry its {sourceIndex} in the statement' };
    }
    return { kind: 'keep', sourceIndex: raw.sourceIndex };
  }
  return validateRevolveAxis(raw);
}

/**
 * The repeat edit request's shape, mirroring {@link validateRepeat} with the
 * edit-only forms: axis/plane slots may be `keep` (an absent slot reads as
 * keep — the statement's own expression stays verbatim), and the optional
 * target list mixes `verbatim` keeps with re-picked feature statements; an
 * absent list keeps every statement target. Numeric options land on
 * `edit.repeat`; picked inputs ride the request for boundary synthesis.
 */
export function validateRepeatEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { kind, count, centered, angle } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular' && kind !== 'mirror' && kind !== 'rotate') {
    return { error: 'kind must be "linear", "circular", "mirror" or "rotate"' };
  }
  const result: StatementEditRequest = base;
  const rp: NonNullable<FeatureStatementEditTarget['repeat']> = { kind };
  edit.repeat = rp;

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_REPEAT_TARGETS) {
      return { error: `targets must be 1-${MAX_REPEAT_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['repeatTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const raw of body.targets) {
      if (raw?.kind === 'verbatim') {
        if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(raw.sourceIndex);
        targets.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
      } else if (raw?.kind === 'feature') {
        const loc = validateSketchLoc(raw);
        if (!loc) {
          return { error: 'each re-picked target must be the {filePath, line} of a feature statement' };
        }
        const key = `${loc.filePath}:${loc.line}`;
        if (seenLocs.has(key)) {
          return { error: 'the same feature was picked twice — each target must be different' };
        }
        seenLocs.add(key);
        targets.push({ kind: 'feature', loc });
      } else {
        return { error: 'each target must be {kind: "verbatim"|"feature", …}' };
      }
    }
    result.repeatTargets = targets;
  }

  if (kind === 'mirror') {
    for (const key of ['axis', 'directions', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a mirror repeat takes no ${key}` };
      }
    }
    const raw = body?.plane;
    if (raw === undefined || raw === null || raw?.kind === 'keep') {
      result.repeatPlane = { kind: 'keep' };
    } else if (raw?.kind === 'standard') {
      if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
        return { error: 'a standard mirror plane must be "xy", "xz" or "yz"' };
      }
      result.repeatPlane = { kind: 'standard', plane: raw.plane };
    } else if (raw?.kind === 'plane') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a plane input must carry the plane {filePath, line}' };
      }
      result.repeatPlane = { kind: 'plane', loc };
    } else if (raw?.kind === 'face') {
      const pick = validatePick(raw.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a picked mirror plane must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      result.repeatPlane = { kind: 'face', pick };
      result.needsPicks = true;
    } else {
      return { error: 'plane must be {kind: "keep"|"standard"|"plane"|"face", …}' };
    }
    return result;
  }

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} repeat takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear repeat carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
      }
    }
    if (centered !== undefined && typeof centered !== 'boolean') {
      return { error: 'centered must be a boolean' };
    }
    const spacingMode = body?.spacingMode;
    if (spacingMode !== 'offset' && spacingMode !== 'length') {
      return { error: 'spacingMode must be "offset" or "length"' };
    }
    const raw = body?.directions;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REPEAT_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_REPEAT_DIRECTIONS} axis directions` };
    }
    const directions: NonNullable<StatementEditRequest['repeatDirections']> = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      // An absent axis keeps the statement's own axis at this position.
      const axis = entry?.axis === undefined || entry?.axis === null
        ? { kind: 'keep' as const, sourceIndex: i }
        : validateRepeatEditAxis(entry.axis);
      if ('error' in axis) {
        return axis;
      }
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
      }
      result.needsPicks ||= axis.kind === 'edge';
      directions.push({ axis, count: entry.count, value: entry.value });
    }
    rp.spacingMode = spacingMode;
    rp.centered = centered === true ? true : undefined;
    result.repeatDirections = directions;
    return result;
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: 'only a linear repeat takes directions' };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear repeat takes a spacingMode' };
  }
  // An absent axis keeps the statement's own (its single axis argument).
  const axis = body?.axis === undefined || body?.axis === null
    ? { kind: 'keep' as const, sourceIndex: 0 }
    : validateRepeatEditAxis(body.axis);
  if ('error' in axis) {
    return axis;
  }
  result.needsPicks ||= axis.kind === 'edge';
  result.repeatAxis = axis;

  if (kind === 'rotate') {
    for (const key of ['count', 'sweep', 'centered'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a rotate repeat takes no ${key}` };
      }
    }
    if (!validValueExpr(angle, { nonzero: true })) {
      return { error: 'angle must be a nonzero rotation in degrees' };
    }
    rp.angle = angle;
    return result;
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  if (angle !== undefined && angle !== null) {
    return { error: 'a circular repeat carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular repeat takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  rp.count = count;
  rp.sweep = { mode: sweep.mode, value: sweep.value };
  return result;
}
