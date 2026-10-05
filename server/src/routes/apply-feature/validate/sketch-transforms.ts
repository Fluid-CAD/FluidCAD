// In-sketch copy and mirror request validation.

import { validCountValue, validValueExpr, type ValueExpr } from '../../../apply-feature-edit/index.ts';
import { validateCopySkip } from './copy.ts';

/** One 2D copy direction's axis: a sketch-local axis or a picked line edge. */
type SketchCopyAxisInput = { kind: 'local'; axis: 'x' | 'y' } | { kind: 'edge' };

/**
 * The in-sketch copy request's option payload (`copy2d`): the kind plus its
 * inputs — linear directions (each a sketch-local axis or an edge pick,
 * with its own count and value, sharing one offset/length spacing mode) or
 * a center point with count and sweep for circular. The target picks ride
 * `sketchEntities` and the per-direction edge picks `sketchAxisEntities`,
 * both resolved by the sketch synthesis kernel.
 */
type SketchCopyRequest = {
  kind: 'linear' | 'circular';
  directions?: { axis: SketchCopyAxisInput; count: ValueExpr; value: ValueExpr }[];
  spacingMode?: 'offset' | 'length';
  centered?: boolean;
  center?: [ValueExpr, ValueExpr];
  count?: ValueExpr;
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  skip?: number[][];
};

export function validateSketchCopy(body: any): SketchCopyRequest | { error: string } {
  const raw = body?.copy2d;
  if (!raw || typeof raw !== 'object') {
    return { error: 'copy2d must carry the copy options' };
  }
  const { kind, centered } = raw;
  if (kind !== 'linear' && kind !== 'circular') {
    return { error: 'copy2d.kind must be "linear" or "circular"' };
  }
  if (kind === 'linear') {
    if (raw.center !== undefined || raw.count !== undefined || raw.sweep !== undefined) {
      return { error: 'a linear copy carries its counts and values in the directions' };
    }
    if (centered !== undefined && typeof centered !== 'boolean') {
      return { error: 'centered must be a boolean' };
    }
    if (raw.spacingMode !== 'offset' && raw.spacingMode !== 'length') {
      return { error: 'spacingMode must be "offset" or "length"' };
    }
    const rawDirs = raw.directions;
    if (!Array.isArray(rawDirs) || rawDirs.length < 1 || rawDirs.length > 2) {
      return { error: 'directions must be 1-2 axis directions' };
    }
    const directions: NonNullable<SketchCopyRequest['directions']> = [];
    for (const entry of rawDirs) {
      const axis = entry?.axis;
      const isLocal = axis?.kind === 'local' && (axis.axis === 'x' || axis.axis === 'y');
      if (!isLocal && axis?.kind !== 'edge') {
        return { error: 'each direction axis must be {kind: "local", axis: "x"|"y"} or {kind: "edge"}' };
      }
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
      }
      directions.push({
        axis: isLocal ? { kind: 'local', axis: axis.axis } : { kind: 'edge' },
        count: entry.count,
        value: entry.value,
      });
    }
    const skip = validateCopySkip(raw.skip, directions.length);
    if ('error' in skip) {
      return skip;
    }
    return {
      kind, directions, spacingMode: raw.spacingMode, centered: centered === true,
      skip: skip.length > 0 ? skip : undefined,
    };
  }
  if (raw.directions !== undefined || raw.spacingMode !== undefined) {
    return { error: 'only a linear copy takes directions' };
  }
  if (centered === true) {
    return { error: 'a circular copy takes no centered flag' };
  }
  const center = raw.center;
  if (!Array.isArray(center) || center.length !== 2 || !center.every((v: unknown) => validValueExpr(v))) {
    return { error: 'center must be an [x, y] pair of numbers or expressions' };
  }
  if (!validCountValue(raw.count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  const sweep = raw.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  const skip = validateCopySkip(raw.skip, 1);
  if ('error' in skip) {
    return skip;
  }
  return {
    kind, center: [center[0], center[1]], count: raw.count,
    sweep: { mode: sweep.mode, value: sweep.value },
    skip: skip.length > 0 ? skip : undefined,
  };
}

/**
 * The in-sketch mirror request's option payload (`mirror2d`): the line to
 * reflect across — a sketch-local axis (the Sketch X / Sketch Y quick
 * buttons) or a picked sketch line whose single `{shapeId}` rides
 * `sketchAxisEntities`. The target picks ride `sketchEntities`; both are
 * resolved by the sketch synthesis kernel. No op, no numbers — a 2D mirror
 * is its line and its targets.
 */
type SketchMirrorRequest = {
  axis: SketchCopyAxisInput;
};

export function validateSketchMirror(body: any): SketchMirrorRequest | { error: string } {
  const raw = body?.mirror2d;
  if (!raw || typeof raw !== 'object') {
    return { error: 'mirror2d must carry the mirror options' };
  }
  const axis = raw.axis;
  const isLocal = axis?.kind === 'local' && (axis.axis === 'x' || axis.axis === 'y');
  if (!isLocal && axis?.kind !== 'edge') {
    return { error: 'mirror2d.axis must be {kind: "local", axis: "x"|"y"} or {kind: "edge"}' };
  }
  return { axis: isLocal ? { kind: 'local', axis: axis.axis } : { kind: 'edge' } };
}
