import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, extrude, fillet, select } from "../../core/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SelectSceneObject } from "../../features/select.js";
import { Matrix4 } from "../../math/matrix4.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { testRect } from "../helpers/profiles.js";
import { TestSheets } from "../helpers/sheets.js";
import { FreeformBodies } from "../helpers/freeform-bodies.js";
import { surface } from "../helpers/topology-surfaces.js";

const selected = (value: unknown) => value as SceneObject;

/** A 40 × 20 × 10 box from the origin. */
function box(): ExtrudeBase {
  sketch("xy", () => {
    testRect(40, 20);
  });
  return extrude(10) as unknown as ExtrudeBase;
}

/** A 200 × 100 × 50 block whose vertical edges are rounded by 10: four flat walls, four rounds, two caps. */
function roundedBlock(): ExtrudeBase {
  sketch("xy", () => {
    testRect(200, 100);
    fillet(10);
  });
  return extrude(50) as unknown as ExtrudeBase;
}

const topOf = (shapes: unknown[]) => (shapes as Edge[]).every(e => Math.abs(ShapeOps.getBoundingBox(e).centerZ - 10) < 1e-6);

describe("edge().between(a, b)", () => {
  setupOC();

  it("takes the edges where faces of two descriptions meet", () => {
    roundedBlock();
    const flatsMeetRounds = selected(select(edge().between(face().planar(), face().cylinderCurve())));
    const roundsMeetRounds = selected(select(edge().between(face().cylinderCurve(), face().cylinderCurve())));
    const topRim = selected(select(edge().between(face().onPlane("xy", 50), face())));
    render();

    // Each round meets two walls along its sides and the two caps along its arcs.
    expect(flatsMeetRounds.getShapes()).toHaveLength(16);
    expect(roundsMeetRounds.getShapes()).toHaveLength(0);
    expect(topRim.getShapes()).toHaveLength(8);
  });

  it("takes the edges where two referenced groups of faces meet", () => {
    const e = box();
    const top = selected(select(edge().between(e.sideFaces(), e.endFaces())));
    const apart = selected(select(edge().between(e.startFaces(), e.endFaces())));
    render();

    expect(top.getShapes()).toHaveLength(4);
    expect(topOf(top.getShapes())).toBe(true);
    expect(apart.getShapes()).toHaveLength(0);
  });

  it("does not care about the order of its arguments", () => {
    const e = roundedBlock();
    const ab = selected(select(edge().between(face().planar(), face().cylinderCurve())));
    const ba = selected(select(edge().between(face().cylinderCurve(), face().planar())));
    const refAb = selected(select(edge().between(e.sideFaces(), e.endFaces())));
    const refBa = selected(select(edge().between(e.endFaces(), e.sideFaces())));
    render();

    expect(ba.getShapes()).toEqual(ab.getShapes());
    expect(refBa.getShapes()).toEqual(refAb.getShapes());
    expect(refAb.getShapes()).toHaveLength(8);
  });

  it("takes the edge where a free-form face meets its neighbour", () => {
    // No fill tool yet (step 26): a loft's B-spline wall stands for the fill,
    // its flat ends for the faces it meets.
    FreeformBodies.ellipseLoft();
    const both = selected(select(edge().between(face().freeform(), face().planar())));
    const wall = select(face().freeform());
    const toTop = selected(select(edge().between(wall, face().planar().farthest("z"))));
    const toAnything = selected(select(edge().between(wall, face())));
    render();

    expect(both.getShapes()).toHaveLength(2);
    expect(toTop.getShapes()).toHaveLength(1);
    expect(ShapeOps.getBoundingBox(toTop.getShapes()[0]).centerZ).toBeCloseTo(30, 6);
    expect(toAnything.getShapes()).toHaveLength(2);
  });

  it("survives a fillet that rebuilt the referenced faces", () => {
    const e = box();
    fillet(2, e.sideEdges());
    const top = selected(select(edge().between(e.sideFaces(), e.endFaces())));
    render();

    // The walls and the top were rebuilt by the fillet, and are found by
    // the planes they lie on: the four straight top edges, not the rounds'.
    const edges = top.getShapes() as Edge[];
    expect(edges).toHaveLength(4);
    expect(topOf(edges)).toBe(true);
  });

  it("never takes an open rim, and between(face(), face()) is every interior edge", () => {
    surface(() => [TestSheets.openBox(10, 10, 10)]);
    const interior = selected(select(edge().between(face(), face())));
    const notInterior = selected(select(edge().notBetween(face(), face())));
    render();

    expect(interior.getShapes()).toHaveLength(8);
    expect(notInterior.getShapes()).toHaveLength(4);
  });

  it("is told from its twin", () => {
    roundedBlock();
    const not = selected(select(edge().notBetween(face().planar(), face().cylinderCurve())));
    render();

    // The straight top and bottom edges, where the walls meet the caps.
    expect(not.getShapes()).toHaveLength(8);
    expect(edge().between(face().planar(), face()).equals(edge().between(face().planar(), face()))).toBe(true);
    expect(edge().between(face().planar(), face()).equals(edge().notBetween(face().planar(), face()))).toBe(false);
    expect(edge().between(face().planar(), face()).equals(edge().between(face(), face().planar()))).toBe(false);
    const moved = edge().between(face().onPlane("xy"), face()).transform(Matrix4.fromTranslation(0, 0, 5));
    expect(moved.equals(edge().between(face().onPlane("xy"), face()))).toBe(false);
  });

  it("declares a referenced feature as a dependency of the select()", () => {
    const e = box();
    const sides = e.sideFaces();
    const sel = select(edge().between(sides, face().planar())) as unknown as SelectSceneObject;
    expect(sel.getDependencies()).toContain(sides);
  });

  it("is refused without two face groups", () => {
    expect(() => (edge() as any).between(face())).toThrow(/between\(a, b\): takes two face groups/);
    expect(() => edge().between(face().withChain(), face())).toThrow(/withChain\(\)/);
  });
});
