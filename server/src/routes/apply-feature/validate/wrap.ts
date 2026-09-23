// wrap request validation.

import { validValueExpr, type RegionKey, type ValueExpr } from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick } from '../picks.ts';
import { validateRegionKeys } from '../regions.ts';

/**
 * The wrap request's shape: the sketch is always an explicit input (wrap()
 * never consumes the active sketch implicitly), the target face is a pick to
 * synthesize a selector from, and the thickness is the pad height along the
 * surface normal.
 */
type WrapRequest = {
  op: 'add' | 'remove' | 'new';
  thickness: ValueExpr;
  sketch: SketchLoc;
  face: Pick;
  /** The picked sketch regions; empty writes no `.region(…)`. */
  regions: RegionKey[];
};

export function validateWrap(body: any): WrapRequest | { error: string } {
  const { op, thickness, sketch } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (!validValueExpr(thickness, { positive: true })) {
    return { error: 'thickness must be a positive number or expression' };
  }
  const sketchLoc = validateSketchLoc(sketch);
  if (!sketchLoc) {
    return { error: 'sketch must be the {filePath, line} of the sketch to wrap' };
  }
  const pick = validatePick(body?.face);
  if (!pick || pick.sub.type !== 'face') {
    return { error: 'face must be a {shapeId, sub:{type:"face", index}} pick' };
  }
  const regionResult = validateRegionKeys(body);
  if ('error' in regionResult) {
    return regionResult;
  }
  return { op, thickness, sketch: sketchLoc, face: pick, regions: regionResult.regions };
}
