import { Affine, type Affine2 } from '../../../../lib/io/drawing/affine.js';
import type { DrawingBounds } from '../../../../lib/io/drawing/drawing.js';
import type { SketchImageData } from '../../types';
import { ReferenceImageFrame } from './reference-image-frame';

/**
 * Where an imported drawing sits in the sketch, the way its frame is
 * dragged: the centre of the drawing's bounds lands on `at`, turned by
 * `angle` about it, each file unit `scale` sketch units long.
 */
export type DrawingPlacement = {
  /** The centre of the drawing's bounds, in sketch coordinates. */
  at: [number, number];
  /** Degrees, counter-clockwise. */
  angle: number;
  /** Sketch units per file unit: the unit conversion times the scale the user asked for. */
  scale: number;
};

/** A side of the frame is never thinner than this share of the other: a drawing of one straight line still has a body to grab. */
const MIN_ASPECT = 0.08;

/** The side of the frame, in file units, around a drawing with no size at all: one point. */
const LONE_POINT_FRAME = 1;

/**
 * The placement of an imported drawing as geometry: the frame the handles
 * are drawn on (the Image tool's own rectangle, so the two tools feel the
 * same), the map that takes the file's curves into the sketch, and the
 * placements a gesture or a button leads to.
 */
export class DrawingPlacements {
  /** The drawing where the file has it: file coordinates read as sketch coordinates, `scale` times as long. */
  static asDrawn(bounds: DrawingBounds, scale: number): DrawingPlacement {
    const center = DrawingPlacements.center(bounds);
    return { at: [center.x * scale, center.y * scale], angle: 0, scale };
  }

  /** The same drawing with its bounds' centre on `at`. */
  static centeredOn(placement: DrawingPlacement, at: [number, number]): DrawingPlacement {
    return { ...placement, at: [at[0], at[1]] };
  }

  /** Whether the drawing sits where the file has it: unturned, file coordinates times its scale. */
  static isAsDrawn(placement: DrawingPlacement, bounds: DrawingBounds): boolean {
    const natural = DrawingPlacements.asDrawn(bounds, placement.scale);
    const reach = Math.max(
      (bounds.max.x - bounds.min.x) * placement.scale,
      (bounds.max.y - bounds.min.y) * placement.scale,
      Math.abs(natural.at[0]),
      Math.abs(natural.at[1]),
      Number.MIN_VALUE,
    );
    return placement.angle === 0
      && Math.abs(placement.at[0] - natural.at[0]) <= reach * 1e-9
      && Math.abs(placement.at[1] - natural.at[1]) <= reach * 1e-9;
  }

  /**
   * The placement when the scale changes for a reason other than a drag —
   * another unit, a typed factor. A drawing left where the file has it stays
   * where the file has it (its coordinates scale with it); one that was
   * moved or turned grows about its own centre, where the user put it.
   */
  static rescaled(placement: DrawingPlacement, scale: number, bounds: DrawingBounds): DrawingPlacement {
    if (DrawingPlacements.isAsDrawn(placement, bounds)) {
      return DrawingPlacements.asDrawn(bounds, scale);
    }
    return { at: [placement.at[0], placement.at[1]], angle: placement.angle, scale };
  }

  /** File coordinates → sketch coordinates. */
  static affine(placement: DrawingPlacement, bounds: DrawingBounds): Affine2 {
    const center = DrawingPlacements.center(bounds);
    return Affine.compose(
      Affine.translation({ x: -center.x, y: -center.y }),
      Affine.placement(placement.scale, (placement.angle * Math.PI) / 180, { x: placement.at[0], y: placement.at[1] }),
    );
  }

  /** The frame around the placed drawing: its bounds, never thinner than a grabbable strip. */
  static frame(placement: DrawingPlacement, bounds: DrawingBounds): ReferenceImageFrame {
    const size = DrawingPlacements.frameSize(bounds);
    const spec: SketchImageData = {
      src: '',
      width: size.width * placement.scale,
      height: size.height * placement.scale,
      at: [placement.at[0], placement.at[1]],
      angle: placement.angle,
      opacity: 1,
    };
    return new ReferenceImageFrame(spec, null);
  }

  /** The placement a frame gesture left: the frame's record read back. */
  static fromFrame(spec: SketchImageData, bounds: DrawingBounds): DrawingPlacement {
    const size = DrawingPlacements.frameSize(bounds);
    return {
      at: [spec.at[0], spec.at[1]],
      angle: spec.angle,
      scale: (spec.width ?? size.width) / size.width,
    };
  }

  /** The drawing's own width and height once placed, in sketch units. */
  static size(placement: DrawingPlacement, bounds: DrawingBounds): { width: number; height: number } {
    return {
      width: (bounds.max.x - bounds.min.x) * placement.scale,
      height: (bounds.max.y - bounds.min.y) * placement.scale,
    };
  }

  static center(bounds: DrawingBounds): { x: number; y: number } {
    return { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
  }

  /** The frame's sides in file units: the bounds', the thin one widened to a share of the other. A lone point gets a square to be grabbed by. */
  private static frameSize(bounds: DrawingBounds): { width: number; height: number } {
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;
    const long = Math.max(width, height);
    if (!(long > 0)) {
      return { width: LONE_POINT_FRAME, height: LONE_POINT_FRAME };
    }
    return { width: Math.max(width, long * MIN_ASPECT), height: Math.max(height, long * MIN_ASPECT) };
  }
}
