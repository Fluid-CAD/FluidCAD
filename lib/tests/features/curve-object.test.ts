import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import repeat from "../../core/repeat.js";
import { line } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { getCurrentScene } from "../../scene-manager.js";
import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { CurveObject } from "../../features/curve-object.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { AnchoredLazyVertex } from "../../features/anchored-vertex.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PointResolver } from "../../features/point-resolver.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { Point } from "../../math/point.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { chord, TestChord } from "../helpers/result-fixtures.js";

const asObject = (value: unknown) => value as SceneObject;
const xyz = (point: Point) => [point.x, point.y, point.z].map(v => +v.toFixed(6) + 0);
const at = (vertex: LazyVertex) => xyz(PointResolver.toWorld(vertex));
const endsOf = (shape: Shape) => {
  const edgeShape = shape as Edge;
  return [xyz(edgeShape.getFirstPoint()), xyz(edgeShape.getLastPoint())];
};

/** A curve tool whose build returns whatever the test hands it. */
class StubCurve extends CurveObject {
  constructor(private readonly make: () => Shape[]) {
    super();
  }

  protected buildCurves(_context: BuildSceneObjectContext): Shape[] {
    return this.make();
  }

  override getType(): string {
    return 'test-chord';
  }

  serialize() {
    return {};
  }
}

/** Two straight pieces, (10, 0, 0) → (0, 0, 0) → (0, -10, 0): each runs against its canonical direction. */
function elbow(): Shape[] {
  const edges = [
    EdgeOps.makeLineEdge(new Point(10, 0, 0), new Point(0, 0, 0)),
    EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(0, -10, 0)),
  ];
  try {
    return [WireOps.makeWireFromEdges(edges)];
  } finally {
    edges.forEach(piece => piece.dispose());
  }
}

/** A 20 × 10 × 5 block on XY from the origin. */
function block(): Extrude {
  sketch("xy", () => {
    testRect(20, 10);
  });
  return extrude(5) as unknown as Extrude;
}

describe("CurveObject", () => {
  setupOC();

  describe("the result", () => {
    it("holds the wires its build returned", () => {
      const c = chord([0, 0, 0], [10, 0, 0]);
      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0]).toBeInstanceOf(Wire);
      expect(c.getError()).toBeNull();
    });

    it("answers its edges in walk order, all or by index", () => {
      const c = new StubCurve(elbow);
      addToScene(c);
      const all = asObject(c.edges());
      const second = asObject(c.edges(1));
      addToScene(all);
      addToScene(second);
      render();

      expect(all.getShapes().map(endsOf)).toEqual([
        [[10, 0, 0], [0, 0, 0]],
        [[0, 0, 0], [0, -10, 0]],
      ]);
      expect(second.getShapes().map(endsOf)).toEqual([[[0, 0, 0], [0, -10, 0]]]);
    });

    it("narrows its edges by a filter", () => {
      const c = new StubCurve(elbow);
      addToScene(c);
      const alongX = asObject(c.edges(edge().parallelTo("xz")));
      addToScene(alongX);
      render();

      expect(alongX.getShapes().map(endsOf)).toEqual([[[10, 0, 0], [0, 0, 0]]]);
    });

    it("starts and ends where the curve runs, whatever its edges' own direction", () => {
      const c = new StubCurve(elbow);
      addToScene(c);
      const start = c.start();
      const end = c.end();
      render();

      expect(at(start)).toEqual([10, 0, 0]);
      expect(at(end)).toEqual([0, -10, 0]);
    });

    it("gives its ends as anchors on the edge that holds them", () => {
      const c = new StubCurve(elbow);
      addToScene(c);
      const end = c.end();
      render();

      expect(end).toBeInstanceOf(AnchoredLazyVertex);
      at(end);
      const anchor = end as AnchoredLazyVertex;
      expect(endsOf(anchor.getAnchorShape())).toEqual([[0, 0, 0], [0, -10, 0]]);
      // The last piece runs towards −Y, so the curve ends at that edge's own start.
      expect(anchor.getAnchorSpec()).toEqual({ kind: "start" });
    });

    it("swaps its ends when the tool runs the other way", () => {
      const forward = chord([0, 0, 0], [10, 0, 0]);
      const backward = chord([0, 0, 0], [10, 0, 0]).reversed();
      const ends = [forward.start(), forward.end(), backward.start(), backward.end()];
      render();

      expect(ends.map(at)).toEqual([[0, 0, 0], [10, 0, 0], [10, 0, 0], [0, 0, 0]]);
    });

    it("records its edges under the edges bucket and as its own additions", () => {
      const c = chord([0, 0, 0], [10, 0, 0]);
      const scene = render();

      const index = new SelectionIndex(scene);
      try {
        const piece = (c.getShapes()[0] as Wire).getEdges()[0];
        const hits = index.findHits(index.keyOf(piece), "edge");
        expect(hits.map(hit => [hit.bucket.feature, hit.bucket.def.accessor, hit.index])).toEqual([[c, "edges", 0]]);
        expect(index.creatorOf(index.keyOf(piece))).toBe(c);
      } finally {
        index.dispose();
      }
    });
  });

  describe("refusals", () => {
    it("names the tool when no curve was made", () => {
      const c = new StubCurve(() => []);
      addToScene(c);
      render();

      expect(c.getError()).toMatch(/^test-chord: no curve was made\./);
      expect(c.getShapes()).toEqual([]);
    });

    it("refuses a result that is not a curve", () => {
      const c = new StubCurve(() => [TestSheets.plate(10, 5)]);
      addToScene(c);
      render();

      expect(c.getError()).toMatch(/test-chord: a curve tool leaves edges or wires, and its build returned a surface/);
      expect(c.getShapes()).toEqual([]);
    });
  });

  describe("as an operand", () => {
    it("is hidden by the tool that reads it, and still read by the next", () => {
      const c = chord([0, 0, 0], [10, 0, 0]);
      const first = chord([0, 0, 0], [0, 0, 1]).along(c);
      const second = chord([0, 0, 0], [0, 0, 1]).along(c);
      const scene = render();

      expect(first.getError()).toBeNull();
      expect(second.getError()).toBeNull();
      expect(second.getShapes()).toHaveLength(1);
      expectDisplayConsumed(scene, c);
    });

    it("leaves a solid it reads an edge of in the scene", () => {
      const box = block();
      const c = chord([0, 0, 0], [0, 0, 1]).along(asObject(box));
      render();

      // A solid is refused as a curve, and reading it never consumed it.
      expect(c.getError()).toMatch(/chord curve is a solid/);
      expect(asObject(box).getShapes()).toHaveLength(1);
    });
  });

  describe("an operand given through a chained method", () => {
    it("builds a lazy accessor before the tool reads it", () => {
      const box = block();
      const c = chord([0, 0, 0], [1, 0, 0]).along(asObject(box.sideEdges(0)));
      render();

      expect(c.getError()).toBeNull();
      const piece = (c.getShapes()[0] as Wire).getEdges()[0];
      const [from, to] = endsOf(piece);
      // A side edge of the block: vertical, as tall as the extrusion.
      expect([from[0], from[1]]).toEqual([to[0], to[1]]);
      expect(Math.abs(from[2] - to[2])).toBe(5);
    });

    it("claims a select(), so a later bare call does not take it as the last selection", () => {
      block();
      const earlier = select(edge().verticalTo("xy")) as unknown as SelectSceneObject;
      const rim = select(edge().verticalTo("xy").nearest("x").nearest("y")) as unknown as SelectSceneObject;
      expect(getCurrentScene().getLastSelection()).toBe(rim);

      chord([0, 0, 0], [1, 0, 0]).along(rim);

      expect(rim.isClaimed()).toBe(true);
      expect(getCurrentScene().getLastSelection()).toBe(earlier);
    });

    it("takes the selection's highlight when it builds", () => {
      block();
      const rim = select(edge().verticalTo("xy").nearest("x").nearest("y")) as unknown as SelectSceneObject;
      const c = chord([0, 0, 0], [1, 0, 0]).along(rim);
      render();

      expect(c.getError()).toBeNull();
      expect(rim.getShapes()).toEqual([]);
    });
  });

  describe("repeat()", () => {
    it("gives each copy its own edges bucket, moved with the copy", () => {
      const path = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
      }));
      const c = chord([0, 0, 0], [1, 0, 0]).along(path);
      const r = repeat("linear", "x", { count: 2, offset: 50 }, c) as unknown as RepeatBase;
      const copied = asObject(r.instance(1).edges(0));
      addToScene(copied);
      render();

      const [copy] = r.getInstanceRoots(1);
      expect(copy).toBeInstanceOf(TestChord);
      expect(copy).not.toBe(c);
      expect(copy.getError()).toBeNull();
      const bucket = copy.getState("section-edges") as Edge[];
      expect(bucket.map(endsOf).map(ends => ends.map(point => point[0]).sort((a, b) => a - b))).toEqual([[50, 60]]);
      expect(copied.getShapes()).toEqual(bucket);
    });

    it("moves the ends of a copy with it", () => {
      const path = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
      }));
      const c = chord([0, 0, 0], [1, 0, 0]).along(path);
      const r = repeat("linear", "y", { count: 2, offset: 30 }, c) as unknown as RepeatBase;
      render();

      const copy = r.getInstanceRoots(1)[0] as TestChord;
      const ends = [at(copy.start()), at(copy.end())].sort((a, b) => a[0] - b[0]);
      expect(ends).toEqual([[0, 30, 0], [10, 30, 0]]);
    });
  });
});
