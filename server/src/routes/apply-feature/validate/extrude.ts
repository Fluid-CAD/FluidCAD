// extrude request validation.

import {
  validValueExpr,
  type ExtrudeFaceTarget,
  type RegionKey,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick } from '../picks.ts';
import { validateRegionKeys } from '../regions.ts';
import { validateProfileFeature, validateThinOffsets } from './common.ts';

/** The dialog-editable extrude options, shared by the create and edit paths. */
type ExtrudeOptionSet = {
  op: 'add' | 'remove' | 'new';
  distance: ValueExpr | null;
  distance2: ValueExpr | null;
  symmetric: boolean;
  draft: ValueExpr | null;
  endOffset: ValueExpr | null;
  drill: boolean;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
};

/**
 * The extrude request's shape. The profile is a sketch — `active` consumes it
 * implicitly, `bound` binds it to a variable. `toFace` is the optional
 * up-to-face target, which replaces the distance(s): a picked face to
 * synthesize a selector from, or the `'first-face'` / `'last-face'` literal
 * the kernel resolves itself.
 */
type ExtrudeRequest = ExtrudeOptionSet & {
  profile: { mode: 'active' | 'bound'; feature: 'sketch' | 'offset' } & SketchLoc;
  toFace?: Pick | ExtrudeFaceTarget;
  /** Solid statements the boolean is scoped to; empty writes no `.scope(…)`. */
  scope: SketchLoc[];
  /** The picked profile regions; empty writes no `.region(…)`. */
  regions: RegionKey[];
};

/**
 * Validate the option fields both extrude requests carry: the boolean op,
 * the distance(s) — one, two (asymmetric both-ways), or null for a
 * through-all remove — plus the symmetric / draft / endOffset / drill / thin
 * chains. `symmetric` and `distance2` are competing direction modes and
 * exclude each other; a through-all remove has no explicit distances to pair.
 * `toFace` (the create path's up-to-face mode) replaces the distances
 * entirely and excludes the symmetric direction mode; `endOffset` survives it
 * — it shifts the target face the extrusion stops on.
 */
export function validateExtrudeOptions(body: any, toFace = false): ExtrudeOptionSet | { error: string } {
  const { op, distance, distance2, symmetric, draft, endOffset, drill, thin } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (toFace) {
    if (distance !== undefined && distance !== null) {
      return { error: 'a to-face extrude takes no distance — the target face bounds it' };
    }
  } else if (distance === null) {
    if (op !== 'remove') {
      return { error: 'distance may be null (through-all) only for a remove' };
    }
  } else if (!validValueExpr(distance, { nonzero: true })) {
    return { error: 'distance must be a nonzero number or expression (negative extrudes the other way)' };
  }
  if (distance2 !== undefined && distance2 !== null) {
    if (toFace) {
      return { error: 'a to-face extrude takes no second distance' };
    }
    if (!validValueExpr(distance2, { nonzero: true })) {
      return { error: 'distance2 must be a nonzero number or expression' };
    }
    if (distance === null) {
      return { error: 'a two-distance extrude cannot be through-all' };
    }
    if (symmetric === true) {
      return { error: 'a two-distance extrude cannot be symmetric' };
    }
  }
  if (symmetric !== undefined && typeof symmetric !== 'boolean') {
    return { error: 'symmetric must be a boolean' };
  }
  if (symmetric === true && toFace) {
    return { error: 'a to-face extrude cannot be symmetric' };
  }
  if (draft !== undefined && draft !== null && !validValueExpr(draft, { nonzero: true })) {
    return { error: 'draft must be a nonzero taper angle in degrees' };
  }
  if (endOffset !== undefined && endOffset !== null && !validValueExpr(endOffset, { nonzero: true })) {
    return { error: 'endOffset must be a nonzero pull-back distance' };
  }
  if (drill !== undefined && typeof drill !== 'boolean') {
    return { error: 'drill must be a boolean' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  return {
    op,
    distance: distance ?? null,
    distance2: distance2 ?? null,
    symmetric: symmetric === true,
    draft: draft ?? null,
    endOffset: endOffset ?? null,
    drill: drill !== false,
    thin: thinResult.offsets,
  };
}

export function validateExtrude(body: any): ExtrudeRequest | { error: string } {
  const target = body?.toFace;
  const hasToFace = target !== undefined && target !== null;
  const options = validateExtrudeOptions(body, hasToFace);
  if ('error' in options) {
    return options;
  }
  const mode = body?.profile?.mode;
  const loc = validateSketchLoc(body?.profile);
  const profileFeature = validateProfileFeature(body?.profile?.feature);
  if ((mode !== 'active' && mode !== 'bound') || !loc || !profileFeature) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch or offset' };
  }
  if (profileFeature === 'offset' && mode !== 'bound') {
    return { error: 'an offset profile is always bound to a variable' };
  }
  const scopeResult = validateScopeLocs(body, options.op);
  if ('error' in scopeResult) {
    return scopeResult;
  }
  const regionResult = validateRegionKeys(body);
  if ('error' in regionResult) {
    return regionResult;
  }
  const scope = scopeResult.scope;
  const regions = regionResult.regions;
  const profile = { mode, feature: profileFeature, ...loc };
  if (!hasToFace) {
    return { ...options, profile, scope, regions };
  }
  if (target === 'first-face' || target === 'last-face') {
    return { ...options, profile, toFace: target, scope, regions };
  }
  const pick = validatePick(target);
  if (!pick || pick.sub.type !== 'face') {
    return { error: 'toFace must be "first-face", "last-face" or a {shapeId, sub:{type:"face", index}} pick' };
  }
  return { ...options, profile, toFace: pick, scope, regions };
}
