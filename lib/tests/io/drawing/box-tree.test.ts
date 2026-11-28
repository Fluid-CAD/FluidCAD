import { describe, it, expect } from "vitest";
import { BoxTree } from "../../../oc/projection/box-tree.js";
import { CoverMesh } from "../../../oc/projection/cover-mesh.js";

/** A repeatable stream of numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("BoxTree", () => {
  // Sizes from specks to a box spanning the lot, and long thin ones: what a drawing holds.
  function boxes(count: number): Float64Array {
    const next = random(7);
    const out = new Float64Array(count * 4);
    for (let i = 0; i < count; i++) {
      const x = next() * 1000;
      const y = next() * 1000;
      const w = next() < 0.1 ? next() * 800 : next() * 5;
      const h = next() < 0.1 ? next() * 800 : next() * 5;
      out.set([x, y, x + w, y + h], 4 * i);
    }
    return out;
  }

  it("finds exactly the boxes over a point", () => {
    const all = boxes(2000);
    const tree = new BoxTree(all, 2000);
    const next = random(11);
    for (let q = 0; q < 200; q++) {
      const x = next() * 1100 - 50;
      const y = next() * 1100 - 50;
      const found: number[] = [];
      tree.atPoint(x, y, (item) => found.push(item));
      const expected: number[] = [];
      for (let i = 0; i < 2000; i++) {
        if (x >= all[4 * i] && y >= all[4 * i + 1] && x <= all[4 * i + 2] && y <= all[4 * i + 3]) {
          expected.push(i);
        }
      }
      expect(found.sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it("finds every box a segment passes through, each once", () => {
    const all = boxes(2000);
    const tree = new BoxTree(all, 2000);
    const next = random(13);
    for (let q = 0; q < 100; q++) {
      const [x0, y0, x1, y1] = [next() * 1000, next() * 1000, next() * 1000, next() * 1000];
      const found: number[] = [];
      tree.alongSegment(x0, y0, x1, y1, 0, (item) => found.push(item));
      expect(new Set(found).size).toBe(found.length);
      // Every box holding a point of the segment is among them.
      for (let s = 0; s <= 400; s++) {
        const x = x0 + ((x1 - x0) * s) / 400;
        const y = y0 + ((y1 - y0) * s) / 400;
        for (let i = 0; i < 2000; i++) {
          if (x >= all[4 * i] && y >= all[4 * i + 1] && x <= all[4 * i + 2] && y <= all[4 * i + 3]) {
            expect(found).toContain(i);
          }
        }
      }
    }
  });

  it("answers nothing when empty, and for items all in one place", () => {
    const empty = new BoxTree([], 0);
    const none: number[] = [];
    empty.atPoint(0, 0, (item) => none.push(item));
    expect(none).toEqual([]);

    const stacked = new Float64Array(40 * 4);
    for (let i = 0; i < 40; i++) {
      stacked.set([1, 1, 2, 2], 4 * i);
    }
    const found: number[] = [];
    new BoxTree(stacked, 40).atPoint(1.5, 1.5, (item) => found.push(item));
    expect(found).toHaveLength(40);
  });
});

describe("CoverMesh", () => {
  // One triangle facing the viewer at depth 10, one seen edge-on, one tilted 60° through depth 10 at x = 0.
  const facing = [0, 0, 10, 10, 0, 10, 0, 10, 10];
  const edgeOn = [0, 0, 0, 10, 0, 0, 10, 0, 50];
  const s = Math.tan(Math.PI / 3);
  const tilted = [20, 0, 10, 30, 0, 10 + 10 * s, 20, 10, 10];

  function mesh(bands: number[]): CoverMesh {
    return new CoverMesh(Float64Array.from([...facing, ...edgeOn, ...tilted]), Int32Array.from([0, 1, 2]), bands);
  }

  it("answers how far in front the face over a point stands, within the face's mesh error", () => {
    const cover = mesh([0.5, 0, 0]);
    cover.lookup(2, 2, 4);
    expect(cover.low).toBeCloseTo(5.5, 9);
    expect(cover.high).toBeCloseTo(6.5, 9);
    expect(cover.hits).toEqual([0]);
  });

  it("answers nothing where no face is over the point or the face is behind it", () => {
    const cover = mesh([0, 0, 0]);
    cover.lookup(9, 9, 4); // outside the triangle
    expect(cover.high).toBe(-Infinity);
    cover.lookup(2, 2, 12); // the face is behind
    expect(cover.high).toBe(-Infinity);
    expect(cover.hits).toEqual([]);
  });

  it("ignores a face seen edge-on", () => {
    const cover = mesh([0, 0, 0]);
    cover.lookup(5, 0, -5);
    expect(cover.hits).not.toContain(1);
  });

  it("measures square to the face, not along the sight line", () => {
    const cover = mesh([0, 0, 0]);
    // One unit into the tilted face its surface is tan 60° higher, and half that far from the point.
    cover.lookup(21, 2, 10);
    expect(cover.low).toBeCloseTo(s * Math.cos(Math.PI / 3), 9);
  });
});
