// Cursor ↔ label placement: the screen half of `.labelAt(u, v)`.
//
// A dimension's value is carried by the cursor twice — while its label is
// dragged to a new spot, and while a new dimension is placed as it is drawn.
// Both ask the same question: which placement draws the text centered where
// the cursor is? The answer depends on a pixel amount (the clearance between
// a value and the line it hangs off), so it needs the camera; everything
// else is the pure frame math in sketch-solver-client/dimension-label.ts.

import { SceneContext } from '../scene/scene-context';
import { PlaneData } from '../types';
import { labelCenter, labelCoordsForCenter, placedDimension } from '../sketch-solver-client';
import type { DimensionFrame, LabelCoords } from '../sketch-solver-client';
import type { Vec2 } from '../sketch-solver-client/resolve';
import { placedLabelOffsetPx } from '../meshes/containers/glyph-box';
import type { BoxPx } from '../meshes/containers/glyph-box';
import { pixelToSketchThreshold, sketchToClient } from './sketch-plane-utils';

/** An angle's arc cannot be pulled tighter than this around its corner. */
const MIN_ANGLE_ARC_PX = 12;
/** Screen span used to read a sketch direction off the camera — long enough
 * to stay well conditioned at any zoom. */
const DIRECTION_PROBE_PX = 100;

export class DimensionLabelPlacer {
  constructor(private ctx: SceneContext) {}

  /**
   * The placement that draws a value's text centered on `center` (sketch
   * coordinates): the text follows the cursor and its dimension line, leader
   * or arc trails one clearance behind. `box` is the text's drawn box.
   */
  coordsFor(plane: PlaneData, frame: DimensionFrame, center: Vec2, box: BoxPx): LabelCoords {
    const localPerPx = pixelToSketchThreshold(this.ctx, 1);
    return labelCoordsForCenter(frame, center, {
      clearance: push => this.clearancePx(plane, frame, box, push, center) * localPerPx,
      minArcRadius: MIN_ANGLE_ARC_PX * localPerPx,
    });
  }

  /**
   * Where a placement draws the center of its text, in sketch coordinates —
   * the inverse of {@link coordsFor}. Null for a placement that cannot be
   * drawn (see placedDimension).
   */
  centerOf(plane: PlaneData, frame: DimensionFrame, coords: LabelCoords, box: BoxPx): Vec2 | null {
    const placed = placedDimension(frame, coords);
    if (!placed) {
      return null;
    }
    const localPerPx = pixelToSketchThreshold(this.ctx, 1);
    return labelCenter(
      placed,
      push => this.clearancePx(plane, frame, box, push, placed.attach) * localPerPx,
    );
  }

  /**
   * How far the text's center sits off its attach point when pushed along
   * `push` (sketch-local), px — the sprite layer's own rule, so a placement
   * computed here lands where it will be drawn. An aligned value rolls to
   * its line, which puts its short side across the push whatever the angle;
   * an upright one reaches differently along every screen direction.
   */
  private clearancePx(plane: PlaneData, frame: DimensionFrame, box: BoxPx, push: Vec2, at: Vec2): number {
    const aligned = frame.type === 'radial' || (frame.type === 'span' && frame.aligned);
    return placedLabelOffsetPx(
      { ...box, roll: 0 },
      aligned ? { x: 0, y: 1 } : this.screenDirection(plane, push, at),
    );
  }

  /** A sketch-plane direction as a unit screen direction (px, y down). */
  private screenDirection(plane: PlaneData, dir: Vec2, at: Vec2): { x: number; y: number } {
    const reach = pixelToSketchThreshold(this.ctx, DIRECTION_PROBE_PX);
    const from = sketchToClient(this.ctx, plane, at);
    const to = sketchToClient(this.ctx, plane, [at[0] + dir[0] * reach, at[1] + dir[1] * reach]);
    const x = to.clientX - from.clientX;
    const y = to.clientY - from.clientY;
    const length = Math.hypot(x, y);
    // Edge-on to the sketch nothing is readable anyway — any direction does.
    return length > 1e-6 ? { x: x / length, y: y / length } : { x: 0, y: -1 };
  }
}
