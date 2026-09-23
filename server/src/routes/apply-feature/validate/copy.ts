// copy request validation (create and edit).

import {
  validCountValue,
  validValueExpr,
  type FeatureStatementEditTarget,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validateSketchPicks } from '../picks.ts';
import { validateRepeatEditAxis, type RepeatEditAxisInput } from './repeat.ts';
import { validateRevolveAxis, type RevolveAxisInput } from './revolve.ts';
import type { StatementEditRequest } from './statement-edit.ts';

/** One linear copy direction: its axis plus that direction's count and value. */
type CopyDirectionInput = { axis: RevolveAxisInput; count: ValueExpr; value: ValueExpr };

type CopyRequest = {
  kind: 'linear' | 'circular';
  /** The feature statements being copied, in argument order. */
  targets: SketchLoc[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: CopyDirectionInput[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  axis?: RevolveAxisInput;
  count?: ValueExpr;
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  centered?: boolean;
  /** Instances to leave out, one index per direction; absent skips none. */
  skip?: number[][];
};

export const MAX_COPY_TARGETS = 16;

const MAX_COPY_DIRECTIONS = 3;

/** The ceiling on one statement's skip list — the dialog's own (copy-skip.ts). */
const MAX_COPY_SKIP = 256;

/**
 * A copy's `skip` option: index tuples naming the instances to leave out, one
 * index per direction at most (a circular copy states one each). Plain whole
 * numbers only — a skip names literal positions, never expressions, so the
 * dialog can check them against the counts beside them. Absent or empty writes
 * no option at all.
 */
export function validateCopySkip(raw: unknown, arity: number): number[][] | { error: string } {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_COPY_SKIP) {
    return { error: `skip must be at most ${MAX_COPY_SKIP} index tuples` };
  }
  const entries: number[][] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length === 0 || entry.length > arity) {
      return { error: `each skip entry must name 1-${arity} instance ${arity > 1 ? 'indices' : 'index'}` };
    }
    if (!entry.every(index => Number.isSafeInteger(index) && index >= 0)) {
      return { error: 'each skip index must be a whole number counting from 0' };
    }
    entries.push(entry as number[]);
  }
  return entries;
}

/**
 * The copy request's shape, mirroring {@link validateRepeat} without the
 * mirror/rotate kinds: the kind, one or more target feature statements
 * addressed by their source locations, plus the kind's inputs — linear
 * directions (each an axis with its own count and value, sharing one
 * offset/length spacing mode) or a single axis for circular (a standard
 * world axis, an existing axis statement, or a picked edge), and the numeric
 * options (count with a sweep for circular).
 */
export function validateCopy(body: any): CopyRequest | { error: string } {
  const { kind, targets, count, centered } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular') {
    return { error: 'kind must be "linear" or "circular"' };
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COPY_TARGETS) {
    return { error: `targets must be 1-${MAX_COPY_TARGETS} feature statements to copy` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the copy targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  const filePath = targetLocs[0].filePath;

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} copy takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear copy carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
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
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_COPY_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_COPY_DIRECTIONS} axis directions` };
    }
    const directions: CopyDirectionInput[] = [];
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
    const skip = validateCopySkip(body?.skip, directions.length);
    if ('error' in skip) {
      return skip;
    }
    return {
      kind, targets: targetLocs, directions, spacingMode, centered: centered === true,
      skip: skip.length > 0 ? skip : undefined,
    };
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: 'only a linear copy takes directions' };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear copy takes a spacingMode' };
  }
  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
    return { error: 'the axis and the targets live in different files' };
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  if (body?.angle !== undefined && body?.angle !== null) {
    return { error: 'a circular copy carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular copy takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  const skip = validateCopySkip(body?.skip, 1);
  if ('error' in skip) {
    return skip;
  }
  return {
    kind, targets: targetLocs, axis, count,
    sweep: { mode: sweep.mode, value: sweep.value },
    skip: skip.length > 0 ? skip : undefined,
  };
}

/**
 * One copy-edit axis field: the repeat shapes plus the 2D in-sketch forms —
 * a sketch-local axis, or a picked sketch edge whose `{shapeId}` rides
 * `sketchAxisEntities` in direction order.
 */
export type CopyEditAxisInput = RepeatEditAxisInput
  | { kind: 'local'; axis: 'x' | 'y' }
  | { kind: 'sketch-edge' };

function validateCopyEditAxis(raw: any): CopyEditAxisInput | { error: string } {
  if (raw?.kind === 'local') {
    if (raw.axis !== 'x' && raw.axis !== 'y') {
      return { error: 'a local axis must be {kind: "local", axis: "x" | "y"}' };
    }
    return { kind: 'local', axis: raw.axis };
  }
  if (raw?.kind === 'sketch-edge') {
    return { kind: 'sketch-edge' };
  }
  return validateRepeatEditAxis(raw);
}

/**
 * The copy edit request's shape, mirroring {@link validateRepeatEdit} without
 * the mirror/rotate kinds: axis slots may be `keep` (an absent slot reads as
 * keep — the statement's own expression stays verbatim), and the optional
 * target list mixes `verbatim` keeps with re-picked feature statements; an
 * absent list keeps every statement target. Numeric options land on
 * `edit.copy`; picked inputs ride the request for boundary synthesis.
 */
export function validateCopyEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { kind, count, centered } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular') {
    return { error: 'kind must be "linear" or "circular"' };
  }
  const result: StatementEditRequest = base;
  const cp: NonNullable<FeatureStatementEditTarget['copy']> = { kind };
  edit.copy = cp;

  // The 2D in-sketch edit re-picks its targets as sketch edges; the whole
  // list replaces the statement's targets in pick order (the offset edit's
  // contract — the pause-before render already shows the world they resolve
  // against, so no boundary rides along).
  if (body?.sketchTargets !== undefined && body?.sketchTargets !== null) {
    if (body?.targets !== undefined && body?.targets !== null) {
      return { error: 'a copy edit carries targets (3D) or sketchTargets (2D), not both' };
    }
    const picks = validateSketchPicks(body.sketchTargets);
    if (!picks) {
      return { error: 'sketchTargets must be a non-empty array of {shapeId} picks' };
    }
    if (picks.length > MAX_COPY_TARGETS) {
      return { error: `sketchTargets must be 1-${MAX_COPY_TARGETS} picks` };
    }
    result.copySketchTargets = picks;
  }

  // The 2D axis edge picks, one per sketch-edge direction in order; checked
  // against the direction list before each return.
  if (body?.sketchAxisEntities !== undefined && body?.sketchAxisEntities !== null) {
    const picks = validateSketchPicks(body.sketchAxisEntities);
    if (!picks) {
      return { error: 'sketchAxisEntities must be a non-empty array of {shapeId} picks' };
    }
    result.copyAxisPicks = picks;
  }
  const checkAxisPicks = (edgeCount: number): { error: string } | null =>
    (result.copyAxisPicks?.length ?? 0) === edgeCount
      ? null
      : { error: 'sketchAxisEntities must carry exactly one pick per sketch-edge direction' };

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_COPY_TARGETS) {
      return { error: `targets must be 1-${MAX_COPY_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['copyTargets']> = [];
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
    result.copyTargets = targets;
  }

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} copy takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle', 'center'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear copy carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
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
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_COPY_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_COPY_DIRECTIONS} axis directions` };
    }
    const directions: NonNullable<StatementEditRequest['copyDirections']> = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      // An absent axis keeps the statement's own axis at this position.
      const axis = entry?.axis === undefined || entry?.axis === null
        ? { kind: 'keep' as const, sourceIndex: i }
        : validateCopyEditAxis(entry.axis);
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
    const skip = validateCopySkip(body?.skip, directions.length);
    if ('error' in skip) {
      return skip;
    }
    const axisPicks = checkAxisPicks(directions.filter(d => d.axis.kind === 'sketch-edge').length);
    if (axisPicks) {
      return axisPicks;
    }
    cp.spacingMode = spacingMode;
    cp.centered = centered === true ? true : undefined;
    // The dialog owns the option outright: an absent list drops the
    // statement's own, exactly as an unticked `centered` does.
    cp.skip = skip.length > 0 ? skip : undefined;
    result.copyDirections = directions;
    return result;
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: 'only a linear copy takes directions' };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear copy takes a spacingMode' };
  }
  if (body?.center !== undefined && body?.center !== null) {
    // The 2D in-sketch form: the center pair replaces the axis argument
    // outright — the dialog always sends its field values.
    if (body?.axis !== undefined && body?.axis !== null) {
      return { error: 'a copy edit carries an axis or a center, not both' };
    }
    const center = body.center;
    if (!Array.isArray(center) || center.length !== 2 || !center.every((v: unknown) => validValueExpr(v))) {
      return { error: 'center must be an [x, y] pair of numbers or expressions' };
    }
    cp.center = [center[0], center[1]];
  } else {
    // An absent axis keeps the statement's own (its single axis argument).
    const axis = body?.axis === undefined || body?.axis === null
      ? { kind: 'keep' as const, sourceIndex: 0 }
      : validateCopyEditAxis(body.axis);
    if ('error' in axis) {
      return axis;
    }
    result.needsPicks ||= axis.kind === 'edge';
    result.copyAxis = axis;
  }
  {
    const axisPicks = checkAxisPicks(result.copyAxis?.kind === 'sketch-edge' ? 1 : 0);
    if (axisPicks) {
      return axisPicks;
    }
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  if (body?.angle !== undefined && body?.angle !== null) {
    return { error: 'a circular copy carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular copy takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  const skip = validateCopySkip(body?.skip, 1);
  if ('error' in skip) {
    return skip;
  }
  cp.count = count;
  cp.sweep = { mode: sweep.mode, value: sweep.value };
  cp.skip = skip.length > 0 ? skip : undefined;
  return result;
}
