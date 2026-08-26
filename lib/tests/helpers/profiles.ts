import sketch from "../../core/sketch.js";
import type { PlaneLike } from "../../math/plane.js";
import { line } from "../../core/2d/index.js";
import {
  coincident, horizontal, vertical, fix, distance,
} from "../../core/constraints/index.js";
import { Sketch } from "../../features/2d/sketch.js";

export interface TestRectOptions {
  /** Bottom-left corner in sketch coordinates (legacy rect() pen position). */
  at?: [number, number];
}

/**
 * The shared solved-mode stand-in for the legacy `rect(w, h)` throwaway
 * profile: four exact lines + the full constraint set (8 coincident,
 * 2 horizontal, 2 vertical, 1 fix, 2 distance = fully constrained).
 * Guesses are exact so the solve converges immediately.
 *
 * Call inside a sketch callback, like the legacy command:
 *   sketch("xy", () => { testRect(100, 50); })
 *
 * Edge order matches the legacy Rect roles: bottom, right, top, left.
 * Negative width/height span the same signed rectangle legacy rect() drew.
 */
export function testRect(width: number, height: number, opts: TestRectOptions = {}) {
  const [x, y] = opts.at ?? [0, 0];
  const b = line([x, y], [x + width, y]);
  const r = line([x + width, y], [x + width, y + height]);
  const t = line([x + width, y + height], [x, y + height]);
  const l = line([x, y + height], [x, y]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [x, y]);
  distance(b.start(), b.end(), Math.abs(width));
  distance(r.start(), r.end(), Math.abs(height));
  return { b, r, t, l };
}

/**
 * One-call replacement for the ubiquitous
 *   sketch(plane, () => { rect(w, h); })
 * fixture. Returns the Sketch.
 */
export function testRectSketch(
  plane: PlaneLike,
  width: number,
  height: number,
  opts: TestRectOptions = {},
): Sketch {
  return sketch(plane, () => {
    testRect(width, height, opts);
  }) as unknown as Sketch;
}
