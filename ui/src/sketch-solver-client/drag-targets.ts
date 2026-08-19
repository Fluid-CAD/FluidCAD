// Per-move drag-target update (sketch-rewrite P4), pure and unit-tested.
//
// A VERTEX grab chases the snapped cursor — the grabbed point should land
// under the pointer. A BODY grab translates every named point of the entity
// by the cursor delta, so the entity moves rigidly under the grab point.
// The mode must come from the hit, never from the target count: a circle
// body grab has exactly one target (its center), and treating it as a
// vertex grab snaps the center onto the pointer — the grabbed rim point
// must stay under the cursor instead.

import type { DragPoint } from '../../../lib/sketch-solver/types.js';

export type SolvedDragMode = 'vertex' | 'body';

export type SolvedDragTarget = {
  point: DragPoint;
  /** The point's position at gesture start — body deltas are relative. */
  origin: [number, number];
};

export function updateDragTargets(
  mode: SolvedDragMode,
  targets: SolvedDragTarget[],
  grabStart: [number, number],
  snapped: [number, number],
): void {
  if (mode === 'vertex') {
    targets[0].point.x = snapped[0];
    targets[0].point.y = snapped[1];
    return;
  }
  const dx = snapped[0] - grabStart[0];
  const dy = snapped[1] - grabStart[1];
  for (const target of targets) {
    target.point.x = target.origin[0] + dx;
    target.point.y = target.origin[1] + dy;
  }
}
