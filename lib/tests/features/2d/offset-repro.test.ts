import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { line, arc, offset } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Edge } from "../../../common/edge.js";

// Regression: profiles drawn by hand have endpoints that only nearly meet
// (here the hLine spans x 0..50 while the vLine/arc sit at x 0.02/50.02).
// Exact-tolerance grouping split such a profile into fragments that each
// offset to a side chosen by their own orientation — the hLine's offset
// landed above the profile while the vLine+arc chain offset inside it.
// Near-connected edges must chain into one wire and offset consistently.
describe("offset near-connected profile", () => {
  setupOC();

  const offsetEdges = (s: Sketch): Edge[] =>
    s.getShapes().filter((sh): sh is Edge => sh instanceof Edge && sh.provenance === 'offset-of');

  const mergedBBox = (edges: Edge[]) => {
    const points = edges.flatMap(e => [e.getFirstVertex().toPoint(), e.getLastVertex().toPoint()]);
    return {
      minX: Math.min(...points.map(p => p.x)),
      maxX: Math.max(...points.map(p => p.x)),
      minY: Math.min(...points.map(p => p.y)),
      maxY: Math.max(...points.map(p => p.y)),
    };
  };

  it("offsets a gapped quarter-pie outward as one closed profile", () => {
    let l: any, l2: any, a: any;
    const s = sketch("xy", () => {
      // Legacy pen walk: hLine(50) from the origin, vLine from [0.02, 0]
      // down 50, arc from the pen's [0.02, -50] to [50.02, 0]. The 0.02
      // gaps are the point of the test — no coincident constraints.
      l = line([0, 0], [50, 0]);
      l2 = line([0.02, 0], [0.02, -50]);
      a = arc([0.02, -50], [50.02, 0], [-0.02, 0.04]);
      offset(5, a, l, l2);
    }) as Sketch;
    render();

    const edges = offsetEdges(s);
    // one closed ring around the whole profile (3 offset segments + corner arcs)
    expect(edges.length).toBeGreaterThanOrEqual(4);

    // every side of the ring lies ~5 outside the original profile
    const bbox = mergedBBox(edges);
    expect(bbox.minX).toBeLessThan(-4);
    expect(bbox.maxX).toBeGreaterThan(54);
    expect(bbox.minY).toBeLessThan(-54);
    expect(bbox.maxY).toBeGreaterThan(4);

    // no fragment offsets into the interior anymore: no offset vertex may sit
    // strictly inside the profile
    for (const edge of edges) {
      for (const p of [edge.getFirstVertex().toPoint(), edge.getLastVertex().toPoint()]) {
        const inside = p.x > 1 && p.x < 49 && p.y < -1 && p.y > -49;
        expect(inside).toBe(false);
      }
    }
  });

  it("offsets a gapped quarter-pie inward with a negative distance", () => {
    let l: any, l2: any, a: any;
    const s = sketch("xy", () => {
      // Legacy pen walk: hLine(50) from the origin, vLine from [0.02, 0]
      // down 50, arc from the pen's [0.02, -50] to [50.02, 0]. The 0.02
      // gaps are the point of the test — no coincident constraints.
      l = line([0, 0], [50, 0]);
      l2 = line([0.02, 0], [0.02, -50]);
      a = arc([0.02, -50], [50.02, 0], [-0.02, 0.04]);
      offset(-5, a, l, l2);
    }) as Sketch;
    render();

    const edges = offsetEdges(s);
    expect(edges.length).toBeGreaterThanOrEqual(3);

    // the whole offset lies strictly inside the original profile
    const bbox = mergedBBox(edges);
    expect(bbox.minX).toBeGreaterThan(4);
    expect(bbox.maxX).toBeLessThan(46);
    expect(bbox.minY).toBeGreaterThan(-46);
    expect(bbox.maxY).toBeLessThan(-4);
  });

  it("still offsets far-apart edges as independent chains", () => {
    let l: any, l2: any;
    const s = sketch("xy", () => {
      l = line([0, 0], [50, 0]);
      l2 = line([0, -20], [0, -70]);
      offset(5, l, l2);
    }) as Sketch;
    render();

    // two separate lines → two separate parallel offset lines
    const edges = offsetEdges(s);
    expect(edges.length).toBe(2);
  });
});
