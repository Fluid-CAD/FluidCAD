import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import plane from "../../core/plane.js";
import { circle, line } from "../../core/2d/index.js";
import { testRect } from "../helpers/profiles.js";
import { Extrude } from "../../features/extrude.js";
import { Edge } from "../../common/edge.js";
import { EdgeOps } from "../../oc/edge-ops.js";

type Buckets = { start: Edge[]; end: Edge[]; internal: Edge[]; all: Edge[] };

function collect(c: Extrude): () => Buckets {
  const start = c.startEdges();
  const end = c.endEdges();
  const internal = c.internalEdges();
  const all = c.edges();
  addToScene(start);
  addToScene(end);
  addToScene(internal);
  addToScene(all);
  return () => ({
    start: start.getShapes() as Edge[],
    end: end.getShapes() as Edge[],
    internal: internal.getShapes() as Edge[],
    all: all.getShapes() as Edge[],
  });
}

const mid = (e: Edge) => EdgeOps.getEdgeMidPoint(e);
const zOf = (e: Edge) => mid(e).z;
const radiusOf = (e: Edge) => Math.hypot(mid(e).x, mid(e).y);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

describe("cut edge classification follows the result topology", () => {
  setupOC();

  it("blind pocket from the top face: rim is start, floor is end, wall creases are internal", () => {
    sketch("xy", () => {
      testRect(100, 100);
    });
    const e = extrude(50) as Extrude;
    sketch(e.endFaces(), () => {
      testRect(40, 40, { at: [30, 30] });
    });
    const c = cut(20) as Extrude;
    const read = collect(c);

    render();

    const b = read();
    expect(b.all).toHaveLength(12);
    expect(b.start).toHaveLength(4);
    expect(b.end).toHaveLength(4);
    expect(b.internal).toHaveLength(4);
    expect(b.start.every(ed => near(zOf(ed), 50))).toBe(true);
    expect(b.end.every(ed => near(zOf(ed), 30))).toBe(true);
    expect(b.internal.every(ed => near(zOf(ed), 40))).toBe(true);
  });

  it("pocket from a plane above the part: the entry rim on the top face is still start", () => {
    sketch("xy", () => {
      testRect(100, 100);
    });
    const e = extrude(50) as Extrude;
    const p = plane(e.endFaces(), 10);
    sketch(p, () => {
      testRect(40, 40, { at: [30, 30] });
    });
    // 30 from z = 60: floor at z = 30, the tool enters the top at z = 50.
    const c = cut(30) as Extrude;
    const read = collect(c);

    render();

    const b = read();
    expect(b.all).toHaveLength(12);
    expect(b.start).toHaveLength(4);
    expect(b.start.every(ed => near(zOf(ed), 50))).toBe(true);
    expect(b.end).toHaveLength(4);
    expect(b.end.every(ed => near(zOf(ed), 30))).toBe(true);
    expect(b.internal).toHaveLength(4);
  });

  it("symmetric through-all skirt cut in a tube: bore rims are start, outer rims are end, per rim chain", () => {
    // Tube: outer r=42.5, inner r=38, z 0..90; the sketch plane (yz) lies in the bore.
    sketch("xy", () => {
      circle([0, 0], 85);
      circle([0, 0], 76);
    });
    extrude(90);
    sketch("yz", () => {
      line([-25, 0], [25, 0]);
      line([25, 0], [25, 30]);
      line([25, 30], [-25, 30]);
      line([-25, 30], [-25, 0]);
    });
    const c = cut().symmetric() as Extrude;
    const read = collect(c);

    render();

    const b = read();
    // The tool moves away from the plane on both sides: it enters material at
    // the bore wall and leaves it at the outer wall, on both sides alike.
    expect(b.start.length).toBeGreaterThan(0);
    expect(b.end.length).toBeGreaterThan(0);
    for (const ed of b.start) {
      expect(radiusOf(ed), `start edge at r=${radiusOf(ed)}`).toBeCloseTo(38, 3);
    }
    for (const ed of b.end) {
      expect(radiusOf(ed), `end edge at r=${radiusOf(ed)}`).toBeCloseTo(42.5, 3);
    }
    // Every rim arc on the bore is start and every rim arc on the outer wall
    // is end: no chain is split between buckets.
    const rimArcs = b.all.filter(ed => near(radiusOf(ed), 38) || near(radiusOf(ed), 42.5));
    expect(rimArcs.length).toBe(b.start.length + b.end.length);
    // The wall/bottom-ring creases at z = 0 run along a face perpendicular
    // to the sweep: internal.
    for (const ed of b.internal.filter(ed => near(zOf(ed), 0))) {
      expect(b.start).not.toContain(ed);
    }
    expect(b.start.length + b.end.length + b.internal.length).toBe(b.all.length);
  });

  it("symmetric cut through a solid plate has no start edges", () => {
    sketch("xy", () => {
      testRect(100, 100);
    });
    extrude(20);
    sketch(plane("xy", 10), () => {
      circle([50, 50], 30);
    });
    const c = cut(40).symmetric() as Extrude;
    const read = collect(c);

    render();

    const b = read();
    // Two exit rims plus the cylindrical wall's seam (a crease between the
    // wall and itself, hence internal).
    expect(b.all).toHaveLength(3);
    expect(b.start).toHaveLength(0);
    expect(b.end).toHaveLength(2);
    expect(b.end.every(ed => near(zOf(ed), 0) || near(zOf(ed), 20))).toBe(true);
    expect(b.internal).toHaveLength(1);
  });
});
