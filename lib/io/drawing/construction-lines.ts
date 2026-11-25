import type { DrawingBounds, Vec2 } from "./drawing.js";

/** A line with no end: through `at`, along `direction` (one unit long) — both ways, or forward only for a ray. */
export type EndlessLine = { at: Vec2; direction: Vec2; ray: boolean };

/** What an endless line is cut to: a segment a sketch can hold. */
export type CutLine = { a: Vec2; b: Vec2 };

/** How far past the drawing a construction line reaches, as a share of the drawing's longer side. */
const MARGIN = 0.1;

/**
 * The side of the frame around construction lines that all run through one
 * point of a file holding nothing else: nothing in the file says how long
 * they should be, so they are a hundred of its units.
 */
const LONE_FRAME = 100;

/**
 * Construction lines — a DXF `XLINE` and `RAY` — as segments.
 *
 * A sketch line has two ends; a construction line has none, or one. It is
 * cut to the drawing it was made to lay out: a frame is put around the rest
 * of the drawing, a tenth of its longer side wider all round, and each line
 * is given the stretch of itself that lies beside that frame — from the
 * first corner of the frame it passes to the last, measured along the line.
 * A line that crosses the drawing then crosses all of it and stops a little
 * past it; a level or upright one is exactly as long as the frame. A line
 * that misses the drawing altogether gets the same stretch, beside the
 * frame instead of over it: it stays where the file has it, and is as long
 * as the drawing is wide seen along it.
 *
 * A ray keeps its start: it runs from there to where a line would stop, and
 * never shorter than the margin — one that points away from the drawing is
 * a stub that long.
 *
 * With nothing else in the file, the frame goes around the points the lines
 * are given by; when those are all one point, it is a square of a hundred
 * units about it.
 */
export class ConstructionLines {
  /**
   * The frame lines are cut to. `content` is the bounds of the rest of the
   * drawing, null when there is none.
   */
  static frame(content: DrawingBounds | null, lines: readonly EndlessLine[]): DrawingBounds {
    let box = content;
    if (!box || !(ConstructionLines.longerSide(box) > 0)) {
      // Nothing to size the lines by but the lines themselves.
      const around = box
        ? { min: { ...box.min }, max: { ...box.max } }
        : { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
      for (const line of lines) {
        around.min.x = Math.min(around.min.x, line.at.x);
        around.min.y = Math.min(around.min.y, line.at.y);
        around.max.x = Math.max(around.max.x, line.at.x);
        around.max.y = Math.max(around.max.y, line.at.y);
      }
      if (!Number.isFinite(around.min.x)) {
        around.min = { x: 0, y: 0 };
        around.max = { x: 0, y: 0 };
      }
      if (!(ConstructionLines.longerSide(around) > 0)) {
        const half = LONE_FRAME / 2;
        return {
          min: { x: around.min.x - half, y: around.min.y - half },
          max: { x: around.min.x + half, y: around.min.y + half },
        };
      }
      box = around;
    }
    const margin = ConstructionLines.longerSide(box) * MARGIN;
    return {
      min: { x: box.min.x - margin, y: box.min.y - margin },
      max: { x: box.max.x + margin, y: box.max.y + margin },
    };
  }

  /** One line cut to `frame` (see the class). */
  static cut(line: EndlessLine, frame: DrawingBounds): CutLine {
    // Where the frame's corners fall along the line, measured from `at`.
    let first = Infinity;
    let last = -Infinity;
    for (const x of [frame.min.x, frame.max.x]) {
      for (const y of [frame.min.y, frame.max.y]) {
        const along = (x - line.at.x) * line.direction.x + (y - line.at.y) * line.direction.y;
        first = Math.min(first, along);
        last = Math.max(last, along);
      }
    }
    const at = (along: number): Vec2 => ({
      x: line.at.x + along * line.direction.x,
      y: line.at.y + along * line.direction.y,
    });
    if (!line.ray) {
      return { a: at(first), b: at(last) };
    }
    // The frame is its content and a margin each side: the margin is this share of its longer side.
    const margin = (ConstructionLines.longerSide(frame) * MARGIN) / (1 + 2 * MARGIN);
    return { a: at(0), b: at(Math.max(last, margin)) };
  }

  /** Every line cut to the frame around `content`, in order. */
  static segments(lines: readonly EndlessLine[], content: DrawingBounds | null): CutLine[] {
    if (lines.length === 0) {
      return [];
    }
    const frame = ConstructionLines.frame(content, lines);
    return lines.map((line) => ConstructionLines.cut(line, frame));
  }

  private static longerSide(box: DrawingBounds): number {
    return Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
  }
}
