/**
 * Where a solid's faces sit in depth: behind its edge lines (offset 0),
 * with overlays that tint a face (hover, selection) between the two.
 *
 * Each half of a solid edge's line lies on the plane of its own face (see
 * face-edge-line.ts), so a face need only be nudged back by a constant few
 * depth steps to lose to it. A face pushed back by its depth slope as well
 * — about a pixel's worth of depth on a steep face — sinks behind more than
 * a thin wall when zoomed out, and the edges behind the wall draw through.
 *
 * A solid whose edges carry no face sides (an engine older than them) still
 * draws its lines at their centerline depth, which sinks into a face falling
 * toward the viewer: its faces keep the slope offset they always had.
 */
export type FaceDepthOffset = { polygonOffsetFactor: number; polygonOffsetUnits: number };

export function faceDepthOffset(overlay: boolean, slopeOffset = false): FaceDepthOffset {
  if (slopeOffset) {
    return overlay
      ? { polygonOffsetFactor: 0.5, polygonOffsetUnits: 0.5 }
      : { polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  }
  return overlay
    ? { polygonOffsetFactor: 0, polygonOffsetUnits: 0.5 }
    : { polygonOffsetFactor: 0, polygonOffsetUnits: 1 };
}
