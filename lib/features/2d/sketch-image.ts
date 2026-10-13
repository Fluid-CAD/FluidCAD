// The `image(src, options)` statement: a reference picture placed on the
// sketch plane, written inside the sketch callback.
//
// The statement is a sketch child with no geometry of its own, like a
// `region()` declaration: nothing solves, profiles or consumes it. The lib
// never reads the file — the row carries the resolved record and the sketch
// plane, and the editor loads the bytes and draws the picture under the
// sketch's lines. Its own timeline row is what the editor double-clicks to
// re-open the picture's handles. A malformed call (no sketch around it, a
// bad option) is stashed and surfaces as the statement's own build error,
// so it never aborts the sketch callback.

import { SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import type { Sketch } from "./sketch.js";

/**
 * The options `image(src, options)` takes: how big the picture
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
 * The resolved reference-image record an image row carries to the editor:
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
 * Validation and defaults for `image()`. A reference image is editor
 * metadata (nothing geometric reads it), but a malformed call is still the
 * statement's own error, with the message pointing at the option.
 */
export class SketchImage {
  static normalize(src: unknown, options: unknown): SketchImageSpec {
    if (typeof src !== 'string' || src.trim() === '') {
      throw new Error('image() needs the image path as its first argument, e.g. image("images/side.png", { width: 120 }).');
    }
    if (options === undefined || options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('image() needs an options object with the image\'s width or height, e.g. image("images/side.png", { width: 120 }).');
    }
    const opts = options as Record<string, unknown>;
    const width = SketchImage.size(opts.width, 'width');
    const height = SketchImage.size(opts.height, 'height');
    if (width === undefined && height === undefined) {
      throw new Error('image() needs a width or a height (the image\'s size on the plane, in document units).');
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
      throw new Error(`image() ${name} must be a positive number (document units), got ${String(value)}.`);
    }
    return value;
  }

  private static position(value: unknown): [number, number] {
    if (value === undefined) {
      return [SKETCH_IMAGE_DEFAULTS.at[0], SKETCH_IMAGE_DEFAULTS.at[1]];
    }
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error('image() at must be the image centre as [x, y] in sketch coordinates.');
    }
    return [value[0], value[1]];
  }

  private static finite(value: unknown, name: string, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`image() ${name} must be a number, got ${String(value)}.`);
    }
    return value;
  }

  private static opacity(value: unknown): number {
    const opacity = SketchImage.finite(value, 'opacity', SKETCH_IMAGE_DEFAULTS.opacity);
    if (opacity < 0 || opacity > 1) {
      throw new Error(`image() opacity must be between 0 (invisible) and 1 (solid), got ${opacity}.`);
    }
    return opacity;
  }
}

/**
 * The `image(src, options)` statement inside a sketch body. It registers
 * with the sketch around it at statement time and carries the resolved
 * record plus that sketch's plane frame on its row; building it only
 * reports a stashed problem.
 */
export class SketchImageStatement extends SceneObject {

  private _spec: SketchImageSpec | null = null;
  private _sketch: Sketch | null = null;
  private _registrationError: string | null = null;

  constructor(private readonly src: unknown, private readonly options: unknown) {
    super();
  }

  /** Validate the call and attach it to the sketch whose callback wrote it (statement time). */
  register(sk: Sketch | null): void {
    if (!sk) {
      this._registrationError = 'image() must be written inside a sketch(plane, callback) body';
      return;
    }
    this._sketch = sk;
    try {
      this._spec = SketchImage.normalize(this.src, this.options);
    } catch (error) {
      this._registrationError = error instanceof Error ? error.message : String(error);
    }
  }

  /** The resolved record, or null when the call was refused. */
  get spec(): SketchImageSpec | null {
    return this._spec;
  }

  get sketch(): Sketch | null {
    return this._sketch;
  }

  build(): void {
    if (this._registrationError) {
      throw new BuildError(this._registrationError);
    }
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SketchImageStatement(this.src, this.options);
    copy._spec = this._spec;
    copy._sketch = (remap.get(this._sketch as unknown as SceneObject) as unknown as Sketch | undefined) ?? this._sketch;
    copy._registrationError = this._registrationError;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof SketchImageStatement) || !super.compareTo(other)) {
      return false;
    }
    return this._registrationError === other._registrationError
      && JSON.stringify(this._spec) === JSON.stringify(other._spec);
  }

  getType(): string {
    return 'image';
  }

  serialize() {
    return {
      ...(this._spec ? { image: this._spec } : {}),
      ...(this._sketch ? { plane: this._sketch.planeObj.serialize() } : {}),
    };
  }
}
