// revolve request validation, including the axis inputs other features reuse.

import { validValueExpr, type RegionPickSpec, type ValueExpr } from '../../../apply-feature-edit/index.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick } from '../picks.ts';
import { validateRegionPicks } from '../regions.ts';
import { validateThinOffsets } from './common.ts';
import { AxisInputs } from '../axis-inputs.ts';

/**
 * One axis input, as every axis slot sends it (revolve, helix, repeat,
 * rotate, copy): a standard world axis string, an existing axis statement
 * addressed by its source location, a picked edge to synthesize an
 * `axis(<selector>)` from, or a connector standing for its Z axis through
 * its origin — its `connector()` statement's call site, plus the pattern
 * slot for one of its copies (`bolt.instance(2)`).
 */
export type RevolveAxisInput =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; loc: SketchLoc }
  | { kind: 'edge'; pick: Pick }
  | { kind: 'connector'; loc: SketchLoc; slot?: number };

/**
 * The revolve request's shape: the profile is a sketch (like extrude); the
 * axis is a standard world axis, an existing axis statement, or a picked
 * edge. The angle is in degrees — 360 (the API default) renders no argument.
 */
type RevolveRequest = {
  op: 'add' | 'remove' | 'new';
  angle: ValueExpr;
  /** `.symmetric()` — the sweep splits equally across the sketch plane. */
  symmetric: boolean;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  axis: RevolveAxisInput;
  /** Solid statements the boolean is scoped to; empty writes no `.scope(…)`. */
  scope: SketchLoc[];
  /** The picked profile regions, declared in the sketch on apply; empty writes no `.region(…)`. */
  regions: RegionPickSpec[];
};

/** One axis field: standard string, axis statement, edge pick, or connector. */
export function validateRevolveAxis(raw: any): RevolveAxisInput | { error: string } {
  if (raw?.kind === 'standard') {
    if (raw.axis !== 'x' && raw.axis !== 'y' && raw.axis !== 'z') {
      return { error: 'a standard axis must be "x", "y" or "z"' };
    }
    return { kind: 'standard', axis: raw.axis };
  }
  if (raw?.kind === 'axis') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'an axis input must carry the axis {filePath, line}' };
    }
    return { kind: 'axis', loc };
  }
  if (raw?.kind === 'edge') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'edge') {
      return { error: 'a picked axis must carry a {shapeId, sub:{type:"edge", index}} pick' };
    }
    return { kind: 'edge', pick };
  }
  if (raw?.kind === 'connector') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a connector axis must carry its connector() {filePath, line}' };
    }
    if (raw.slot !== undefined && raw.slot !== null
      && !(Number.isSafeInteger(raw.slot) && raw.slot >= 0)) {
      return { error: 'a connector axis slot must be a whole number counting from 0' };
    }
    return typeof raw.slot === 'number' ? { kind: 'connector', loc, slot: raw.slot } : { kind: 'connector', loc };
  }
  return { error: 'axis must be {kind: "standard"|"axis"|"edge"|"connector", …}' };
}

export function validateRevolve(body: any): RevolveRequest | { error: string } {
  const { op, angle, symmetric, thin, profile } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (!validValueExpr(angle, { nonzero: true })) {
    return { error: 'angle must be a nonzero sweep angle in degrees' };
  }
  if (symmetric !== undefined && typeof symmetric !== 'boolean') {
    return { error: 'symmetric must be a boolean' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const mode = profile?.mode;
  const profileLoc = validateSketchLoc(profile);
  if ((mode !== 'active' && mode !== 'bound') || !profileLoc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  const axisFile = AxisInputs.fileOf(axis);
  if (axisFile !== null && axisFile !== profileLoc.filePath) {
    return { error: 'the axis and the profile sketch live in different files' };
  }
  const scopeResult = validateScopeLocs(body, op);
  if ('error' in scopeResult) {
    return scopeResult;
  }
  const regionResult = validateRegionPicks(body);
  if ('error' in regionResult) {
    return regionResult;
  }
  return {
    op, angle, symmetric: symmetric === true,
    thin: thinResult.offsets, profile: { mode, ...profileLoc }, axis,
    scope: scopeResult.scope,
    regions: regionResult.regions,
  };
}
