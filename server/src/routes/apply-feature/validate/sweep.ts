// sweep request validation.

import { validValueExpr, type RegionKey, type ValueExpr } from '../../../apply-feature-edit/index.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validateChains, validatePicks, type Pick } from '../picks.ts';
import { validateRegionKeys } from '../regions.ts';
import { validateThinOffsets } from './common.ts';

/**
 * The sweep's `.extend('start', …)` / `.extend('end', …)` amounts: absent or
 * null writes no chain for that end; a value must be positive (the kernel
 * treats a non-positive amount as a no-op, which the dialog must not write).
 */
export function validateSweepExtend(body: any): { extendStart: ValueExpr | null; extendEnd: ValueExpr | null } | { error: string } {
  const result: { extendStart: ValueExpr | null; extendEnd: ValueExpr | null } = { extendStart: null, extendEnd: null };
  for (const key of ['extendStart', 'extendEnd'] as const) {
    const value = body?.[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (!validValueExpr(value, { positive: true })) {
      return { error: `${key} must be a positive number or expression` };
    }
    result[key] = value;
  }
  return result;
}

/**
 * The sweep request's shape: the profile is a sketch (like extrude); the
 * path is either another sketch or edge picks to synthesize a selector from.
 */
type SweepRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** `.extend('start', …)` lead-in before the path, or null for none. */
  extendStart: ValueExpr | null;
  /** `.extend('end', …)` run-out past the path, or null for none. */
  extendEnd: ValueExpr | null;
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  path:
    | ({ kind: 'sketch' } & SketchLoc)
    | { kind: 'edges'; picks: Pick[]; chains: { seed: Pick; members: Pick[] }[] };
  /** Solid statements the boolean is scoped to; empty writes no `.scope(…)`. */
  scope: SketchLoc[];
  /** The picked profile regions; empty writes no `.region(…)`. */
  regions: RegionKey[];
};

export function validateSweep(body: any): SweepRequest | { error: string } {
  const { op, thin, profile, path } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const extend = validateSweepExtend(body);
  if ('error' in extend) {
    return extend;
  }
  const mode = profile?.mode;
  const profileLoc = validateSketchLoc(profile);
  if ((mode !== 'active' && mode !== 'bound') || !profileLoc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const scopeResult = validateScopeLocs(body, op);
  if ('error' in scopeResult) {
    return scopeResult;
  }
  const regionResult = validateRegionKeys(body);
  if ('error' in regionResult) {
    return regionResult;
  }
  const base = {
    op, thin: thinResult.offsets, ...extend, profile: { mode, ...profileLoc }, scope: scopeResult.scope,
    regions: regionResult.regions,
  };
  if (path?.kind === 'sketch') {
    const pathLoc = validateSketchLoc(path);
    if (!pathLoc) {
      return { error: 'a sketch path must carry the sketch {filePath, line}' };
    }
    if (pathLoc.filePath !== profileLoc.filePath) {
      return { error: 'the profile and path sketches live in different files' };
    }
    if (pathLoc.line === profileLoc.line) {
      return { error: 'the profile and path must be different sketches' };
    }
    return { ...base, path: { kind: 'sketch', ...pathLoc } };
  }
  if (path?.kind === 'edges') {
    const picks = validatePicks(path.entities);
    if (!picks) {
      return { error: 'path entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
    }
    const chains = validateChains(path.chains);
    if (!chains) {
      return { error: 'path chains must be {seed, members} pick groups' };
    }
    return { ...base, path: { kind: 'edges', picks, chains } };
  }
  return { error: 'path must be {kind: "sketch", filePath, line} or {kind: "edges", entities}' };
}
