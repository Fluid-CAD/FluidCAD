import { describe, it, expect } from "vitest";
import { ConstructionLines } from "../../../io/drawing/construction-lines.js";
import type { EndlessLine } from "../../../io/drawing/construction-lines.js";
import type { DrawingBounds } from "../../../io/drawing/drawing.js";

// An endless line cut to a length a sketch can hold: beside the frame
// around the rest of the drawing, from the first of its corners the line
// passes to the last.

const box = (x0: number, y0: number, x1: number, y1: number): DrawingBounds => ({ min: { x: x0, y: y0 }, max: { x: x1, y: y1 } });
const through = (at: [number, number], direction: [number, number], ray = false): EndlessLine => {
  const length = Math.hypot(direction[0], direction[1]);
  return { at: { x: at[0], y: at[1] }, direction: { x: direction[0] / length, y: direction[1] / length }, ray };
};

/** A 100 × 40 drawing: its frame is 10 wider all round. */
const PLATE = box(0, 0, 100, 40);

describe("ConstructionLines.frame", () => {
  it("is the drawing's bounds and a tenth of its longer side all round", () => {
    expect(ConstructionLines.frame(PLATE, [])).toEqual(box(-10, -10, 110, 50));
  });

  it("goes around the points the lines are given by when the file holds nothing else", () => {
    const lines = [through([0, 0], [1, 0]), through([50, 20], [0, 1])];
    expect(ConstructionLines.frame(null, lines)).toEqual(box(-5, -5, 55, 25));
  });

  it("is a square of a hundred units about the one point every line runs through", () => {
    const lines = [through([7, -3], [1, 0]), through([7, -3], [0, 1])];
    expect(ConstructionLines.frame(null, lines)).toEqual(box(-43, -53, 57, 47));
  });

  it("takes a drawing of one point with the lines' own points", () => {
    const lone = box(10, 10, 10, 10);
    expect(ConstructionLines.frame(lone, [through([30, 10], [0, 1])])).toEqual(box(8, 8, 32, 12));
    expect(ConstructionLines.frame(lone, [through([10, 10], [0, 1])])).toEqual(box(-40, -40, 60, 60));
  });
});

describe("ConstructionLines.cut", () => {
  const frame = ConstructionLines.frame(PLATE, []);

  it("cuts a level or an upright line to the frame's own sides", () => {
    expect(ConstructionLines.cut(through([37, 12], [1, 0]), frame)).toEqual({ a: { x: -10, y: 12 }, b: { x: 110, y: 12 } });
    expect(ConstructionLines.cut(through([37, 12], [0, 1]), frame)).toEqual({ a: { x: 37, y: -10 }, b: { x: 37, y: 50 } });
  });

  it("gives the same piece of one line wherever on it the file puts its point, and either way it runs", () => {
    const one = ConstructionLines.cut(through([0, 0], [1, 1]), frame);
    const other = ConstructionLines.cut(through([30, 30], [1, 1]), frame);
    const back = ConstructionLines.cut(through([30, 30], [-1, -1]), frame);
    for (const key of ['a', 'b'] as const) {
      expect(other[key].x).toBeCloseTo(one[key].x, 9);
      expect(other[key].y).toBeCloseTo(one[key].y, 9);
    }
    expect(back.a.x).toBeCloseTo(one.b.x, 9);
    expect(back.b.y).toBeCloseTo(one.a.y, 9);
  });

  it("carries a slanted line across the whole frame: from the first corner it passes to the last", () => {
    const { a, b } = ConstructionLines.cut(through([0, 0], [1, 1]), frame);
    // The corners (−10, −10) and (110, 50) are the first and the last along the diagonal.
    expect(a.x).toBeCloseTo(-10, 9);
    expect(a.y).toBeCloseTo(-10, 9);
    expect(b.x).toBeCloseTo(80, 9);
    expect(b.y).toBeCloseTo(80, 9);
  });

  it("gives a line that misses the drawing the stretch beside it, where the file has the line", () => {
    expect(ConstructionLines.cut(through([500, 0], [0, 1]), frame)).toEqual({ a: { x: 500, y: -10 }, b: { x: 500, y: 50 } });
    expect(ConstructionLines.cut(through([0, -300], [1, 0]), frame)).toEqual({ a: { x: -10, y: -300 }, b: { x: 110, y: -300 } });
  });

  it("starts a ray at its start and runs it to where a line would stop", () => {
    expect(ConstructionLines.cut(through([37, 12], [1, 0], true), frame)).toEqual({ a: { x: 37, y: 12 }, b: { x: 110, y: 12 } });
    expect(ConstructionLines.cut(through([37, 12], [-1, 0], true), frame)).toEqual({ a: { x: 37, y: 12 }, b: { x: -10, y: 12 } });
    // From outside, towards the drawing: across all of it.
    expect(ConstructionLines.cut(through([-200, 12], [1, 0], true), frame)).toEqual({ a: { x: -200, y: 12 }, b: { x: 110, y: 12 } });
  });

  it("leaves a ray that points away from the drawing a stub as long as the margin", () => {
    const { a, b } = ConstructionLines.cut(through([200, 12], [1, 0], true), frame);
    expect(a).toEqual({ x: 200, y: 12 });
    expect(b.x).toBeCloseTo(210, 9);
    expect(b.y).toBe(12);
  });
});

describe("ConstructionLines.segments", () => {
  it("cuts every line to one frame, in order, and nothing when there are no lines", () => {
    expect(ConstructionLines.segments([], PLATE)).toEqual([]);
    const cut = ConstructionLines.segments([through([0, 20], [1, 0]), through([50, 0], [0, 1])], PLATE);
    expect(cut).toEqual([
      { a: { x: -10, y: 20 }, b: { x: 110, y: 20 } },
      { a: { x: 50, y: -10 }, b: { x: 50, y: 50 } },
    ]);
  });

  it("sizes two axes through one point of an otherwise empty file", () => {
    const cut = ConstructionLines.segments([through([0, 0], [1, 0]), through([0, 0], [0, 1])], null);
    expect(cut).toEqual([
      { a: { x: -50, y: 0 }, b: { x: 50, y: 0 } },
      { a: { x: 0, y: -50 }, b: { x: 0, y: 50 } },
    ]);
  });
});
