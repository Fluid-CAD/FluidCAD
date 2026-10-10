/**
 * The options `sketch(...).image(src, options)` takes: how big the picture
 * is on the plane, where its centre sits, how it is turned and how faded it
 * draws. Sizes and positions are document units. One of `width` / `height`
 * is required; the other follows the picture's pixel aspect ratio in the
 * editor, and giving both sets an explicit (possibly stretched) size.
 */
export type SketchImageOptions = {
  /** The image's width on the sketch plane, in document units. */
  width?: number;
  /** The image's height on the sketch plane, in document units. */
  height?: number;
  /** Sketch-plane position of the image centre. Default `[0, 0]`. */
  at?: [number, number];
  /** Rotation about the plane normal, degrees counter-clockwise. Default `0`. */
  angle?: number;
  /** 0 = invisible … 1 = solid. Default `0.5`. */
  opacity?: number;
};

/**
 * The resolved reference-image record a sketch row carries to the editor:
 * the path as written (relative to the model file) and every option with
 * its default filled in. `width` / `height` stay as given — whichever is
 * absent is derived from the picture's pixels, which only the editor sees.
 */
export type SketchImageSpec = {
  src: string;
  width?: number;
  height?: number;
  at: [number, number];
  angle: number;
  opacity: number;
};

export const SKETCH_IMAGE_DEFAULTS = Object.freeze({ at: [0, 0] as [number, number], angle: 0, opacity: 0.5 });

/**
 * Validation and defaults for `.image()`. A sketch's reference image is
 * editor metadata (nothing geometric reads it), but a malformed call is
 * still the sketch's own error: it fails the way a bad `.name()` argument
 * would, at the statement that wrote it.
 */
export class SketchImage {
  static normalize(src: unknown, options: unknown): SketchImageSpec {
    if (typeof src !== 'string' || src.trim() === '') {
      throw new Error('sketch: .image() needs the image path as its first argument, e.g. .image("images/side.png", { width: 120 }).');
    }
    if (options === undefined || options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('sketch: .image() needs an options object with the image\'s width or height, e.g. .image("images/side.png", { width: 120 }).');
    }
    const opts = options as Record<string, unknown>;
    const width = SketchImage.size(opts.width, 'width');
    const height = SketchImage.size(opts.height, 'height');
    if (width === undefined && height === undefined) {
      throw new Error('sketch: .image() needs a width or a height (the image\'s size on the plane, in document units).');
    }
    return {
      src: src.trim(),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      at: SketchImage.position(opts.at),
      angle: SketchImage.finite(opts.angle, 'angle', SKETCH_IMAGE_DEFAULTS.angle),
      opacity: SketchImage.opacity(opts.opacity),
    };
  }

  private static size(value: unknown, name: 'width' | 'height'): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`sketch: .image() ${name} must be a positive number (document units), got ${String(value)}.`);
    }
    return value;
  }

  private static position(value: unknown): [number, number] {
    if (value === undefined) {
      return [SKETCH_IMAGE_DEFAULTS.at[0], SKETCH_IMAGE_DEFAULTS.at[1]];
    }
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error('sketch: .image() at must be the image centre as [x, y] in sketch coordinates.');
    }
    return [value[0], value[1]];
  }

  private static finite(value: unknown, name: string, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`sketch: .image() ${name} must be a number, got ${String(value)}.`);
    }
    return value;
  }

  private static opacity(value: unknown): number {
    const opacity = SketchImage.finite(value, 'opacity', SKETCH_IMAGE_DEFAULTS.opacity);
    if (opacity < 0 || opacity > 1) {
      throw new Error(`sketch: .image() opacity must be between 0 (invisible) and 1 (solid), got ${opacity}.`);
    }
    return opacity;
  }
}
