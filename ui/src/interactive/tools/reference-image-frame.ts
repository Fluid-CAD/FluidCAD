import type { SketchImageData } from '../../types';
import type { PixelSize } from '../../scene/reference-image-loader';
import { SketchReferenceImage } from '../../scene/sketch-reference-image';

export type Point2 = [number, number];

/** The four corners, named in the picture's own frame (top = its +y side). */
export type CornerId = 'tl' | 'tr' | 'br' | 'bl';
export const CORNERS: readonly CornerId[] = ['tl', 'tr', 'br', 'bl'];

/** What the pointer is over. */
export type FrameHit =
  | { part: 'rotate' }
  | { part: 'corner'; corner: CornerId }
  | { part: 'body' };

/** Pixel-derived reaches, in sketch units: how close a pointer must come to a handle. */
export type FrameTolerances = {
  /** Reach of a corner handle. */
  corner: number;
  /** Reach of the rotate knob. */
  rotate: number;
  /** How far above the top edge the rotate knob sits. */
  stem: number;
};

/** The smallest a side may be dragged to, in sketch units — a frame must stay grabbable. */
export const MIN_SIDE = 1e-3;

/**
 * The picture's rectangle on the sketch plane as pure 2D geometry: where
 * its corners and rotate knob are, what a pointer over it hits, and what
 * each direct-manipulation gesture does to the written record. No DOM, no
 * Three — the tool drives it with sketch-plane points and the quad's
 * placement follows the record it hands back.
 *
 * The picture's own frame: `u` along its width (the sketch x axis turned by
 * `angle`), `v` along its height; `at` is its centre. A one-sided record
 * (`width` only, the usual case) keeps that shape through every gesture;
 * only a stretch writes both sides.
 */
export class ReferenceImageFrame {
  readonly width: number;
  readonly height: number;
  private readonly cos: number;
  private readonly sin: number;

  constructor(readonly spec: SketchImageData, readonly pixel: PixelSize | null) {
    const size = SketchReferenceImage.resolveSize(spec, pixel);
    this.width = size.width;
    this.height = size.height;
    const rad = (spec.angle * Math.PI) / 180;
    this.cos = Math.cos(rad);
    this.sin = Math.sin(rad);
  }

  // ------------------------------------------------------------- frames

  /** A sketch-plane point in the picture's frame (centre at the origin, unrotated). */
  toLocal(p: Point2): Point2 {
    const dx = p[0] - this.spec.at[0];
    const dy = p[1] - this.spec.at[1];
    return [dx * this.cos + dy * this.sin, -dx * this.sin + dy * this.cos];
  }

  /** A picture-frame point back on the sketch plane. */
  toSketch(l: Point2): Point2 {
    return [
      this.spec.at[0] + l[0] * this.cos - l[1] * this.sin,
      this.spec.at[1] + l[0] * this.sin + l[1] * this.cos,
    ];
  }

  /** A corner in the picture's frame. */
  cornerLocal(id: CornerId): Point2 {
    const hw = this.width / 2;
    const hh = this.height / 2;
    switch (id) {
      case 'tl': return [-hw, hh];
      case 'tr': return [hw, hh];
      case 'br': return [hw, -hh];
      case 'bl': return [-hw, -hh];
    }
  }

  corner(id: CornerId): Point2 {
    return this.toSketch(this.cornerLocal(id));
  }

  static opposite(id: CornerId): CornerId {
    switch (id) {
      case 'tl': return 'br';
      case 'tr': return 'bl';
      case 'br': return 'tl';
      case 'bl': return 'tr';
    }
  }

  /** Where the rotate knob sits: `stem` above the middle of the top edge. */
  rotateKnob(stem: number): Point2 {
    return this.toSketch([0, this.height / 2 + stem]);
  }

  /** The middle of the top edge, where the knob's stem starts. */
  topCenter(): Point2 {
    return this.toSketch([0, this.height / 2]);
  }

  // ---------------------------------------------------------------- hits

  /** The knob first, then the corners, then the body; null off the picture. */
  hitTest(p: Point2, tol: FrameTolerances): FrameHit | null {
    const knob = this.rotateKnob(tol.stem);
    if (ReferenceImageFrame.distance(p, knob) <= tol.rotate) {
      return { part: 'rotate' };
    }
    for (const corner of CORNERS) {
      if (ReferenceImageFrame.distance(p, this.corner(corner)) <= tol.corner) {
        return { part: 'corner', corner };
      }
    }
    const l = this.toLocal(p);
    if (Math.abs(l[0]) <= this.width / 2 && Math.abs(l[1]) <= this.height / 2) {
      return { part: 'body' };
    }
    return null;
  }

  // ------------------------------------------------------------ gestures

  /** The record moved so the point grabbed at `from` now sits under `to`. */
  move(from: Point2, to: Point2): SketchImageData {
    return {
      ...this.spec,
      at: [this.spec.at[0] + (to[0] - from[0]), this.spec.at[1] + (to[1] - from[1])],
    };
  }

  /**
   * Drag corner `id` to `to` with the opposite corner pinned. Keeping the
   * aspect, the new corner is the drag projected onto the diagonal, so the
   * picture scales about the pinned corner and its written side(s) stay the
   * same; stretching lets the two sides go their own way and writes both.
   */
  resizeFromCorner(id: CornerId, to: Point2, keepAspect: boolean): SketchImageData {
    const pin = this.cornerLocal(ReferenceImageFrame.opposite(id));
    const was = this.cornerLocal(id);
    const l = this.toLocal(to);
    const diag: Point2 = [was[0] - pin[0], was[1] - pin[1]];
    let next: Point2;
    if (keepAspect) {
      const len2 = diag[0] * diag[0] + diag[1] * diag[1];
      const s = Math.max(((l[0] - pin[0]) * diag[0] + (l[1] - pin[1]) * diag[1]) / len2, MIN_SIDE / Math.max(this.width, this.height));
      next = [pin[0] + diag[0] * s, pin[1] + diag[1] * s];
    } else {
      // Each side keeps its direction from the pin and never collapses.
      const sx = Math.sign(diag[0]);
      const sy = Math.sign(diag[1]);
      next = [
        pin[0] + sx * Math.max(MIN_SIDE, (l[0] - pin[0]) * sx),
        pin[1] + sy * Math.max(MIN_SIDE, (l[1] - pin[1]) * sy),
      ];
    }
    const width = Math.abs(next[0] - pin[0]);
    const height = Math.abs(next[1] - pin[1]);
    const centerLocal: Point2 = [(pin[0] + next[0]) / 2, (pin[1] + next[1]) / 2];
    return {
      ...this.spec,
      ...this.sizeFields(width, height, !keepAspect),
      at: this.toSketch(centerLocal),
    };
  }

  /**
   * Turn the picture so its knob direction points at `to` (the knob sits
   * on the picture's +v axis, 90° from its width direction). With
   * `snapDegrees`, the angle rounds to that step — the Shift gesture.
   */
  rotateTo(to: Point2, snapDegrees: number | null): SketchImageData {
    const dx = to[0] - this.spec.at[0];
    const dy = to[1] - this.spec.at[1];
    if (dx === 0 && dy === 0) {
      return this.spec;
    }
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI - 90;
    if (snapDegrees) {
      angle = Math.round(angle / snapDegrees) * snapDegrees;
    }
    return { ...this.spec, angle: ReferenceImageFrame.normalizeAngle(angle) };
  }

  /**
   * Calibrate: two points on the picture are really `actual` apart (they
   * measure `measured` now), so the picture scales by their ratio about its
   * centre. Both sides scale, so a stretched record stays stretched.
   */
  calibrate(measured: number, actual: number): SketchImageData {
    if (!(measured > 0) || !(actual > 0)) {
      return this.spec;
    }
    const factor = actual / measured;
    return {
      ...this.spec,
      ...this.sizeFields(this.width * factor, this.height * factor, false),
    };
  }

  /**
   * The size fields to write: the record's own side(s) scaled, unless the
   * gesture stretched — then both.
   */
  private sizeFields(width: number, height: number, stretched: boolean): Pick<SketchImageData, 'width' | 'height'> {
    const both = stretched || (this.spec.width !== undefined && this.spec.height !== undefined);
    if (both) {
      return { width, height };
    }
    if (this.spec.height !== undefined) {
      return { height };
    }
    return { width };
  }

  // ------------------------------------------------------------- helpers

  static distance(a: Point2, b: Point2): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  /** An angle in (−180, 180]. */
  static normalizeAngle(deg: number): number {
    let a = ((deg + 180) % 360 + 360) % 360 - 180;
    if (a === -180) {
      a = 180;
    }
    return Math.round(a * 1000) / 1000;
  }

  /** The CSS cursor for a hit, with the corner cursors following the picture's rotation. */
  static cursorFor(hit: FrameHit | null, angle: number): string {
    if (!hit) {
      return 'default';
    }
    if (hit.part === 'body') {
      return 'move';
    }
    if (hit.part === 'rotate') {
      return 'grab';
    }
    // A corner's diagonal, turned with the picture, picks the nearest of
    // the four resize cursors (they repeat every 180°).
    const base = hit.corner === 'tl' || hit.corner === 'br' ? 135 : 45;
    const dir = ((base + angle) % 180 + 180) % 180;
    if (dir < 22.5 || dir >= 157.5) {
      return 'ew-resize';
    }
    if (dir < 67.5) {
      return 'nesw-resize';
    }
    if (dir < 112.5) {
      return 'ns-resize';
    }
    return 'nwse-resize';
  }
}
