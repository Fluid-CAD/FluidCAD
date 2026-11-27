import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import { sketch, extrude, fillet, select, repeat } from "../../core/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Matrix4 } from "../../math/matrix4.js";
import { heldBodiesOf } from "../../helpers/live-solids.js";
import { testRect } from "../helpers/profiles.js";
import { surface, TopologySheets } from "../helpers/topology-surfaces.js";
import { TestSheets } from "../helpers/sheets.js";

/** A bucket accessor's selection, placed in the scene so the render builds it. */
const built = (value: unknown) => {
  addToScene(value as SceneObject);
  return value as SceneObject;
};

/** A 30 × 30 × 10 plate centred on the origin, pierced by a 10 × 10 square hole: two square loops on each end face. */
function holedPlate(): ExtrudeBase {
  sketch("xy", () => {
    testRect(30, 30, { at: [-15, -15] });
    testRect(10, 10, { at: [-5, -5] });
  });
  return extrude(10) as unknown as ExtrudeBase;
}

/** A 200 × 100 × 50 block whose vertical edges are rounded by 10: lines and arcs around each end face. */
function roundedBlock(): ExtrudeBase {
  sketch("xy", () => {
    testRect(200, 100);
    fillet(10);
  });
  return extrude(50) as unknown as ExtrudeBase;
}

/** Which of a 30-wide plate's two square loops an edge lies on, read from its middle. */
function loopOf(shape: Shape): "outer" | "inner" {
  const box = ShapeOps.getBoundingBox(shape);
  return Math.max(Math.abs(box.centerX), Math.abs(box.centerY)) > 10 ? "outer" : "inner";
}

const loopsOf = (shapes: Shape[]) => [...new Set(shapes.map(loopOf))];

describe("withChain()", () => {
  setupOC();

  describe("in a bucket accessor", () => {
    it("takes the rim loop that holds the seed on a surface with two loops", () => {
      const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]);
      const chains = [0, 1, 2, 3, 4, 5, 6, 7].map(i => built(s.boundaryEdges(edge().at(i).withChain())));
      const seeds = [0, 1, 2, 3, 4, 5, 6, 7].map(i => built(s.boundaryEdges(i)));
      render();

      for (let i = 0; i < 8; i++) {
        const chain = chains[i].getShapes();
        expect(chain).toHaveLength(4);
        expect(chain).toContain(seeds[i].getShapes()[0]);
        expect(loopsOf(chain)).toEqual([loopOf(seeds[i].getShapes()[0])]);
      }
      expect(new Set(chains.map(chain => loopOf(chain.getShapes()[0])))).toEqual(new Set(["outer", "inner"]));
    });

    it("chains through the whole bucket when the builder has no predicate", () => {
      const e = holedPlate();
      const outerTop = built(e.endEdges(edge().first().withChain()));
      const all = built(e.endEdges());
      render();

      expect(all.getShapes()).toHaveLength(8);
      const chain = outerTop.getShapes();
      expect(chain).toHaveLength(4);
      expect(loopsOf(chain)).toHaveLength(1);
    });

    it("chains faces through the edges they share", () => {
      // An open box: a floor and four walls around it, each wall touching the next.
      const s = surface(() => [TestSheets.openBox(10, 10, 10)]);
      const walls = built(s.faces(face().notOnPlane("xy").first().withChain()));
      const whole = built(s.faces(face().first().withChain()));
      render();

      expect(walls.getShapes()).toHaveLength(4);
      expect(whole.getShapes()).toHaveLength(5);
    });
  });

  describe("in select()", () => {
    it("is confined to what the predicates accept", () => {
      holedPlate();
      const everything = select(edge().at(0).withChain()) as unknown as SceneObject;
      const bottomLoop = select(edge().onPlane("xy").at(0).withChain()) as unknown as SceneObject;
      render();

      // The seed's twelve edges — two loops and the walls' edges between
      // them — touch each other, and none of the hole's…
      expect(everything.getShapes()).toHaveLength(12);
      expect(loopsOf(everything.getShapes())).toHaveLength(1);
      // …and within the bottom face, only the seed's loop.
      expect(bottomLoop.getShapes()).toHaveLength(4);
      expect(loopsOf(bottomLoop.getShapes())).toHaveLength(1);
    });

    it("never steps over a shape the predicates refused", () => {
      roundedBlock();
      // The bottom lines touch only arcs, which line() refuses.
      const lines = select(edge().onPlane("xy").line().at(0).withChain()) as unknown as SceneObject;
      const loop = select(edge().onPlane("xy").at(0).withChain()) as unknown as SceneObject;
      render();

      expect(lines.getShapes()).toHaveLength(1);
      expect(loop.getShapes()).toHaveLength(8);
    });

    it("chains faces: the connected run of faces that holds the seed", () => {
      roundedBlock();
      const fillets = select(face().cylinderCurve().at(0).withChain()) as unknown as SceneObject;
      const walls = select(face().notOnPlane("xy").notOnPlane("xy", 50).at(0).withChain()) as unknown as SceneObject;
      render();

      // No two fillet faces touch; the walls and fillets run all the way round.
      expect(fillets.getShapes()).toHaveLength(1);
      expect(walls.getShapes()).toHaveLength(8);
    });

    it("seeds from a trailing rank: the rim loops that touch the bottom", () => {
      // A strip's rim is one loop of six edges; only its two bottom edges are nearest.
      surface(() => [TestSheets.strip([[0, 0], [10, 0], [10, 10]], 5)]);
      // A tube's two rims are loops apart; only the lower one touches the bottom.
      surface(() => [TopologySheets.squareTube(10, 10, 10)]);
      const bottom = select(edge().boundary().nearest("z")) as unknown as SceneObject;
      const loops = select(edge().boundary().nearest("z").withChain()) as unknown as SceneObject;
      render();

      expect(bottom.getShapes()).toHaveLength(6);
      expect(loops.getShapes()).toHaveLength(10);
      const reach = (above: number) => loops.getShapes().filter(shape => ShapeOps.getBoundingBox(shape).maxZ > above);
      // The strip's whole loop — its two ends and its top edges reach z = 5 — and not the tube's top rim.
      expect(reach(4)).toHaveLength(4);
      expect(reach(9)).toHaveLength(0);
    });

    it("seeds from a trailing rank: the loops that hold the nearest edges", () => {
      holedPlate();
      const seed = select(edge().onPlane("xy").nearest("x")) as unknown as SceneObject;
      const loop = select(edge().onPlane("xy").nearest("x").withChain()) as unknown as SceneObject;
      const largest = select(edge().onPlane("xy").smallest().withChain()) as unknown as SceneObject;
      render();

      expect(seed.getShapes()).toHaveLength(1);
      expect(loop.getShapes()).toHaveLength(4);
      expect(loopsOf(loop.getShapes())).toEqual(["outer"]);
      // The hole's four edges tie as the smallest: each is a seed of the same loop.
      expect(largest.getShapes()).toHaveLength(4);
      expect(loopsOf(largest.getShapes())).toEqual(["inner"]);
    });

    it("takes the seed rule wherever withChain() is written in the chain", () => {
      holedPlate();
      const before = select(edge().onPlane("xy").withChain().at(0)) as unknown as SceneObject;
      const after = select(edge().onPlane("xy").at(0).withChain()) as unknown as SceneObject;
      render();

      expect(before.getShapes()).toHaveLength(4);
      expect(before.getShapes()).toEqual(after.getShapes());
    });

    it("is grown before the builders are joined, and withTangents() after, over every candidate", () => {
      roundedBlock();
      // The chain of a lone line is the line; tangency then takes the whole bottom rim.
      const tangent = select(edge().onPlane("xy").line().at(0).withChain().withTangents()) as unknown as SceneObject;
      // A chained builder joined with a plain one: the bottom loop plus one top edge.
      const joined = select(edge().onPlane("xy").at(0).withChain(), edge().onPlane("xy", 50).line().at(0)) as unknown as SceneObject;
      render();

      expect(tangent.getShapes()).toHaveLength(8);
      expect(joined.getShapes()).toHaveLength(9);
    });
  });

  describe("without a seed rule", () => {
    const message = /withChain\(\).*at\(i\).*first\(\).*last\(\).*nearest/;

    it("is refused where select() is written", () => {
      holedPlate();
      expect(() => select(edge().onPlane("xy").withChain())).toThrow(message);
    });

    it("is refused where a bucket accessor is written", () => {
      const e = holedPlate();
      expect(() => e.endEdges(edge().withChain())).toThrow(message);
    });

    it("is refused when a rank is not the last stage", () => {
      holedPlate();
      expect(() => select(edge().nearest("x").onPlane("xy").withChain())).toThrow(message);
      // A negated rank keeps all but a layer: no seed either.
      expect(() => select(edge().onPlane("xy").notNearest("x").withChain())).toThrow(message);
    });
  });

  describe("carried through the language", () => {
    it("is part of the builder's identity and survives transform and remap", () => {
      const chained = edge().line().at(0).withChain();
      expect(chained.equals(edge().line().at(0))).toBe(false);
      expect(chained.equals(edge().line().at(0).withChain())).toBe(true);
      expect(chained.hasChainExpansion()).toBe(true);
      expect(chained.transform(Matrix4.fromTranslation(10, 0, 0)).hasChainExpansion()).toBe(true);
      expect(chained.remap(new Map()).hasChainExpansion()).toBe(true);
      expect(face().at(0).withChain().transform(Matrix4.fromTranslation(0, 5, 0)).equals(face().at(0).withChain())).toBe(true);
    });

    it("needs nothing transformed under a repeat: every copy rounds its own loop", () => {
      const e = holedPlate();
      const f = fillet(1, select(edge().onPlane("xy", 10).nearest("x").withChain()));
      repeat("linear", "x", { count: 3, offset: 60 }, e, f);
      const scene = render();

      const solids = heldBodiesOf(scene.getSceneObjects())
        .map(({ body }) => body)
        .filter((body): body is Solid => body instanceof Solid);
      expect(solids).toHaveLength(3);
      // The plate's 10 faces, and a round on each of the outer top loop's 4 edges.
      expect(solids.map(solid => solid.getFaces().length)).toEqual([14, 14, 14]);
    });
  });
});
