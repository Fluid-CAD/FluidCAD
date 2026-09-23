// wrap(): option types and statement rendering.

import { renderOpChains, renderRegionChain } from '../render/chains.ts';
import { formatValue, type RegionKey, type ValueExpr } from '../value-expr.ts';

/**
 * How a wrap statement is rendered and placed: `wrap(<thickness>, <sketch>,
 * <face>)` plus `.remove()` / `.new()` chains (wrap has no thin mode). The
 * sketch is always an explicit argument — wrap() never consumes the active
 * sketch — so its producer binds to a variable; the target face is the single
 * selector part. The face selector must resolve on the final model, so the
 * statement always inserts at end of scope.
 */
export type WrapEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Pad thickness along the surface normal (always positive). */
  thickness: ValueExpr;
  sketch: { producer: number };
  /**
   * The `.region(…)` picks — the keys of the profile regions the operation
   * builds. Absent or empty writes no chain (every region).
   */
  regions?: RegionKey[];
};

/**
 * Render a wrap statement: `wrap(<thickness>, <sketch>, <face>)` plus the
 * `.remove()` / `.new()` operation chains (wrap has no thin mode). Shared
 * with the route's preview so the previewed text is exactly what the
 * transform writes.
 */
export function renderWrapStatement(
  wr: Pick<WrapEditOptions, 'op' | 'thickness' | 'regions'>,
  sketchExpr: string,
  faceExpr: string,
): string {
  return `wrap(${formatValue(wr.thickness)}, ${sketchExpr}, ${faceExpr})`
    + renderRegionChain(wr.regions) + renderOpChains({ op: wr.op, thin: null });
}
