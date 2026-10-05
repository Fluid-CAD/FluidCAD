// `o.edge(i)` point accessors (loft connections stage 8, D9): indices walk the
// offset from the image of the first drawn source edge, in that edge's own
// direction; rounding arcs and `.close()` caps are ordinary steps of the walk.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import plane from "../../../core/plane.js";
import extrude from "../../../core/extrude.js";
import loft from "../../../core/loft.js";
import { line, offset, origin } from "../../../core/2d/index.js";
import { coincident, horizontal, vertical, distance } from "../../../core/constraints/index.js";
import { Offset } from "../../../features/2d/offset.js";
import { Loft } from "../../../features/loft.js";
import { Extrude } from "../../../features/extrude.js";
import { PointResolver } from "../../../features/point-resolver.js";
import { OffsetEdgePointRef } from "../../../features/2d/offset-edge.js";
import { Point } from "../../../math/point.js";
import { Explorer } from "../../../oc/explorer.js";
import { EdgeOps } from "../../../oc/edge-ops.js";
import { testRect } from "../../helpers/profiles.js";

function world(point: OffsetEdgePointRef): [number, number, number] {
  return PointResolver.toWorld(point).toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number];
}

/** A 40 × 30 rectangle at (10, 5), drawn bottom → right → top → left. */
function rectSketch(distanceValue: number, ...targets: (keyof ReturnType<typeof testRect>)[]) {
  let o!: Offset;
  sketch("xy", () => {
    const r = testRect(40, 30, { at: [10, 5] });
    o = offset(distanceValue, ...targets.map(key => r[key])) as unknown as Offset;
  });
  render();
  return o;
}

describe("offset edge accessors", () => {
  setupOC();

  it("walks an outward offset from the first drawn edge, rounding arcs included", () => {
    const o = rectSketch(5);
    expect(o.edgeShapes(8)).toEqual([]);
    expect(world(o.edge(0).start())).toEqual([10, 0, 0]);
    expect(world(o.edge(0).end())).toEqual([50, 0, 0]);
    // The rounded corner is index 1; its center is the source corner.
    expect(world(o.edge(1).start())).toEqual([50, 0, 0]);
    expect(world(o.edge(1).center())).toEqual([50, 5, 0]);
    expect(world(o.edge(2).start())).toEqual([55, 5, 0]);
    expect(world(o.edge(2).end())).toEqual([55, 35, 0]);
    for (let i = 0; i < 8; i++) {
      expect(world(o.edge(i).end())).toEqual(world(o.edge((i + 1) % 8).start()));
    }
  });

  it("shifts the indices when the sign flips, as an index-based reference does", () => {
    const o = rectSketch(-5);
    expect(o.edgeShapes(4)).toEqual([]);
    expect(world(o.edge(0).start())).toEqual([15, 10, 0]);
    expect(world(o.edge(0).end())).toEqual([45, 10, 0]);
    // Inward there is no rounding arc: index 1 is the right side.
    expect(world(o.edge(1).start())).toEqual([45, 10, 0]);
    expect(world(o.edge(1).end())).toEqual([45, 30, 0]);
    expect(() => o.edge(1).center().asPoint()).toThrow(/edge 1 is a line, not an arc/);
    expect(() => o.edge(4).start().asPoint()).toThrow(/edge 4 does not exist — this offset has 4 edges/);
  });

  it("anchors on statement order, not on the argument order of explicit targets", () => {
    const o = rectSketch(-5, 'l', 't', 'r', 'b');
    expect(world(o.edge(0).start())).toEqual([15, 10, 0]);
    expect(world(o.edge(0).end())).toEqual([45, 10, 0]);
  });

  it("follows the first edge's own direction on a clockwise profile", () => {
    let o!: Offset;
    sketch("xy", () => {
      // Negative width draws the same square clockwise: top edge first, right to left.
      testRect(-40, 40, { at: [40, 0] });
      o = offset(-5) as unknown as Offset;
    });
    render();
    expect(world(o.edge(0).start())).toEqual([35, 5, 0]);
    expect(world(o.edge(0).end())).toEqual([5, 5, 0]);
    expect(world(o.edge(1).start())).toEqual([5, 5, 0]);
    expect(world(o.edge(1).end())).toEqual([5, 35, 0]);
  });

  it.each([5, -5])("walks an open chain from its first drawn edge (distance %s) and continues through the caps", distanceValue => {
    let o!: Offset;
    sketch("xy", () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const c = line([40, 30], [70, 30]);
      coincident(a.start(), origin());
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      horizontal(a);
      vertical(b);
      horizontal(c);
      distance(a.start(), a.end(), 40);
      distance(b.start(), b.end(), 30);
      distance(c.start(), c.end(), 30);
      o = offset(distanceValue).close() as unknown as Offset;
    });
    render();
    const count = o.getShapes().length;
    const sign = Math.sign(distanceValue);
    expect(world(o.edge(0).start())).toEqual([0, 5 * sign, 0]);
    // Outward (+5) the first image is trimmed at the concave corner; inward
    // (-5) it runs to the source corner where a rounding arc begins.
    expect(world(o.edge(0).end())).toEqual([sign > 0 ? 35 : 40, 5 * sign, 0]);
    // Every step of the offset meets the next; the caps then run down to the
    // source's end and back up from the source's start to edge 0.
    for (let i = 0; i < count - 2; i++) {
      expect(world(o.edge(i).end())).toEqual(world(o.edge(i + 1).start()));
    }
    expect(world(o.edge(count - 2).end())).toEqual([70, 30, 0]);
    expect(world(o.edge(count - 1).start())).toEqual([0, 0, 0]);
    expect(world(o.edge(count - 1).end())).toEqual(world(o.edge(0).start()));
  });

  it("walks an open chain from the end drawn first when the statements run the other way", () => {
    let o!: Offset;
    sketch("xy", () => {
      const c = line([40, 30], [70, 30]);
      const b = line([40, 0], [40, 30]);
      const a = line([0, 0], [40, 0]);
      coincident(a.start(), origin());
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      horizontal(a);
      vertical(b);
      horizontal(c);
      distance(a.start(), a.end(), 40);
      distance(b.start(), b.end(), 30);
      distance(c.start(), c.end(), 30);
      o = offset(5) as unknown as Offset;
    });
    render();
    expect(world(o.edge(0).start())).toEqual([70, 35, 0]);
    expect(world(o.edge(0).end())).toEqual([40, 35, 0]);
  });

  it("numbers several wires one after the other in statement order", () => {
    let o!: Offset;
    sketch("xy", () => {
      testRect(20, 20, { at: [100, 0] });
      testRect(20, 20, { at: [0, 0] });
      o = offset(-2) as unknown as Offset;
    });
    render();
    expect(o.getShapes()).toHaveLength(8);
    expect(world(o.edge(0).start())).toEqual([102, 2, 0]);
    expect(world(o.edge(4).start())).toEqual([2, 2, 0]);
  });

  it("resolves on a non-XY plane and keeps its identity per index", () => {
    let o!: Offset;
    sketch(plane("yz", { offset: 10 }), () => {
      testRect(40, 30);
      o = offset(-5) as unknown as Offset;
    });
    render();
    expect(world(o.edge(0).start())).toEqual([10, 5, 5]);
    expect(world(o.edge(2).start())).toEqual([10, 35, 25]);
    expect(o.edge(0).start().compareTo(o.edge(0).start())).toBe(true);
    expect(o.edge(0).start().compareTo(o.edge(1).start())).toBe(false);
    expect(o.edge(0).start().compareTo(o.edge(0).end())).toBe(false);
    expect(o.edge(1).start().serialize()).toMatchObject({ kind: 'sketch-point', ownerType: 'offset', role: 'start', edgeIndex: 1 });
  });

  it("names points of a face-target offset outside any sketch", () => {
    sketch("xy", () => testRect(30, 20));
    const body = extrude(20) as Extrude;
    const o = offset(3, body.endFaces()) as unknown as Offset;
    render();
    expect(o.getError()).toBeNull();
    const start = PointResolver.toWorld(o.edge(0).start());
    expect(start.z).toBeCloseTo(20, 6);
    expect(EdgeOps.distancePointToEdge(start, o.edgeShapes(0)[0])).toBeLessThan(1e-6);
  });

  it("connects loft profiles through offset vertices", () => {
    const inset = () => {
      const r = testRect(40, 40);
      for (const side of Object.values(r)) {
        side.guide();
      }
      return { o: offset(-5, ...Object.values(r)) };
    };
    const a = sketch("xy", inset);
    const b = sketch(plane("xy", { offset: 60 }), inset);
    // Twist by one corner: the automatic matching would pair (5,5) with (5,5).
    const result = loft(a, b)
      .connect(a.geometries.o.edge(0).start(), b.geometries.o.edge(1).start())
      .connect(a.geometries.o.edge(1).start(), b.geometries.o.edge(2).start()) as Loft;
    render();
    expect(result.getError()).toBeNull();
    const solid = result.getShapes()[0];
    for (const [from, to] of [[[5, 5, 0], [35, 5, 60]], [[35, 5, 0], [35, 35, 60]]]) {
      expect(Explorer.findEdgesWrapped(solid).some(edge =>
        EdgeOps.distancePointToEdge(new Point(...from as [number, number, number]), edge) < 1e-6
        && EdgeOps.distancePointToEdge(new Point(...to as [number, number, number]), edge) < 1e-6,
      )).toBe(true);
    }
  });

  it("refuses offset edge points as constraint targets with a clear reason", () => {
    sketch("xy", () => {
      testRect(40, 30);
      const o = offset(-5);
      coincident(o.edge(0).start(), origin());
    });
    const scene = render();
    const errors = scene.getRenderedObjects().filter(object => object.hasError).map(object => object.errorMessage);
    expect(errors.some(message => /offset edge has no solver identity/.test(message ?? ''))).toBe(true);
  });
});
