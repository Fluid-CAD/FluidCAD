import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, extrude, cut, fillet, select, plane } from "../../core/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Matrix4 } from "../../math/matrix4.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { testRect } from "../helpers/profiles.js";
import { surface, TopologySheets } from "../helpers/topology-surfaces.js";

const selected = (value: unknown) => value as SceneObject;
const heights = (shapes: unknown[]) => [...new Set((shapes as Edge[]).map(e => Math.round(ShapeOps.getBoundingBox(e).centerZ * 1e6) / 1e6))].sort();

/** A 30 × 30 × 10 plate centred on the origin, pierced by a 10 × 10 square hole. */
function holedPlate(): ExtrudeBase {
  sketch("xy", () => {
    testRect(30, 30, { at: [-15, -15] });
    testRect(10, 10, { at: [-5, -5] });
  });
  return extrude(10) as unknown as ExtrudeBase;
}

describe("edge().boundaryOf(...faces)", () => {
  setupOC();

  it("is every loop of one face", () => {
    holedPlate();
    const top = selected(select(edge().boundaryOf(face().onPlane("xy", 10))));
    render();

    expect(top.getShapes()).toHaveLength(8);
    expect(heights(top.getShapes())).toEqual([10]);
  });

  it("is the mouth of a pocket, given by its faces", () => {
    sketch("xy", () => {
      testRect(40, 40);
    });
    extrude(20);
    sketch(plane("xy", 20), () => {
      testRect(10, 10, { at: [15, 15] });
    });
    const pocket = cut(5) as unknown as ExtrudeBase;
    const mouth = selected(select(edge().boundaryOf(pocket.internalFaces())));
    render();

    expect(mouth.getShapes()).toHaveLength(4);
    expect(heights(mouth.getShapes())).toEqual([20]);
  });

  it("outlines each of two groups apart", () => {
    holedPlate();
    // The four outer walls touch each other, and the hole's four do; the two groups are apart.
    const outlines = selected(select(edge().boundaryOf(face().notOnPlane("xy").notOnPlane("xy", 10))));
    render();

    // Each group's top and bottom loops; no edge between two walls.
    expect(outlines.getShapes()).toHaveLength(16);
    expect(heights(outlines.getShapes())).toEqual([0, 10]);
  });

  it("joins its arguments into one group", () => {
    holedPlate();
    // The top and the outer walls together: their outline is the bottom
    // outer loop and the hole's top loop.
    const outline = selected(select(edge().boundaryOf(face().onPlane("xy", 10), face().notOnPlane("xy").notOnPlane("xy", 10).farthest("x").withChain())));
    render();

    expect(outline.getShapes()).toHaveLength(8);
    expect(heights(outline.getShapes())).toEqual([0, 10]);
  });

  it("reads a surface's single face the same way: both of its rim loops", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]);
    const rims = selected(select(edge().boundaryOf(s.faces())));
    render();

    expect(rims.getShapes()).toHaveLength(8);
  });

  it("survives a fillet that rebuilt the referenced faces", () => {
    const e = holedPlate();
    fillet(1, e.endEdges());
    const top = selected(select(edge().boundaryOf(e.endFaces())));
    render();

    // The top face shrank inside its rounds and is found by its plane: its two loops, each now inside the rounds.
    expect(top.getShapes()).toHaveLength(8);
    expect(heights(top.getShapes())).toEqual([10]);
  });

  it("is told from its twin", () => {
    holedPlate();
    const rest = selected(select(edge().notBoundaryOf(face().onPlane("xy", 10))));
    render();

    expect(rest.getShapes()).toHaveLength(16);
    expect(edge().boundaryOf(face().planar()).equals(edge().boundaryOf(face().planar()))).toBe(true);
    expect(edge().boundaryOf(face().planar()).equals(edge().notBoundaryOf(face().planar()))).toBe(false);
    expect(edge().boundaryOf(face().planar()).transform(Matrix4.fromTranslation(1, 2, 3)).equals(edge().boundaryOf(face().planar()))).toBe(true);
    expect(() => edge().boundaryOf()).toThrow(/boundaryOf\(\.\.\.faces\): name the faces/);
  });
});
