import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, extrude, fillet, select } from "../../core/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SelectSceneObject } from "../../features/select.js";
import { Matrix4 } from "../../math/matrix4.js";
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

const vertical = (faces: unknown[]) => (faces as Face[]).every(f => Math.abs(f.center().z - 5) < 1e-6);

describe("face().adjacentTo(...refs)", () => {
  setupOC();

  it("takes the faces next to a referenced face, and not the face itself", () => {
    const e = box();
    const walls = selected(select(face().adjacentTo(e.endFaces())));
    render();

    expect(walls.getShapes()).toHaveLength(4);
    expect(vertical(walls.getShapes())).toBe(true);
  });

  it("takes the faces a referenced edge bounds", () => {
    box();
    const topFront = select(edge().onPlane("xy", 10).onPlane("xz"));
    const sides = selected(select(face().adjacentTo(topFront)));
    render();

    // The top face and the front wall.
    expect(sides.getShapes()).toHaveLength(2);
  });

  it("takes the faces along a surface's open rim", () => {
    surface(() => [TestSheets.openBox(10, 10, 10)]);
    const byReference = selected(select(face().adjacentTo(select(edge().boundary()))));
    const byFilter = selected(select(face().adjacentTo(edge().boundary())));
    render();

    expect(byReference.getShapes()).toHaveLength(4);
    expect(vertical(byReference.getShapes())).toBe(true);
    expect(byFilter.getShapes()).toEqual(byReference.getShapes());
  });

  it("takes the faces next to the faces a filter names, leaving those out", () => {
    roundedBlock();
    const nextToRounds = selected(select(face().adjacentTo(face().cylinderCurve())));
    const allPlanar = selected(select(face().adjacentTo(face().planar())));
    render();

    // The four walls and the two caps; the rounds themselves are referenced.
    expect(nextToRounds.getShapes()).toHaveLength(6);
    // Every face touches a flat one, but the flat ones are the reference: the rounds.
    expect(allPlanar.getShapes()).toHaveLength(4);
  });

  it("takes the neighbours of a free-form face", () => {
    // No fill tool yet (step 26): a loft's B-spline wall stands for the fill.
    FreeformBodies.ellipseLoft();
    const ends = selected(select(face().adjacentTo(face().freeform())));
    const fill = select(face().freeform());
    const byRef = selected(select(face().adjacentTo(fill)));
    render();

    expect(ends.getShapes()).toHaveLength(2);
    expect(byRef.getShapes()).toEqual(ends.getShapes());
  });

  it("survives a fillet that rebuilt the referenced face", () => {
    const e = box();
    fillet(2, e.endEdges());
    const nextToTop = selected(select(face().adjacentTo(e.endFaces())));
    render();

    // The top was rebuilt by the fillet and is found by its plane: its neighbours are now the four rounds.
    expect(nextToTop.getShapes()).toHaveLength(4);
    expect((nextToTop.getShapes() as Face[]).every(f => f.center().z > 5)).toBe(true);
  });

  it("is told from its twin", () => {
    const e = box();
    const rest = selected(select(face().notAdjacentTo(e.endFaces())));
    render();

    // The top itself and the bottom.
    expect(rest.getShapes()).toHaveLength(2);
    expect(face().adjacentTo(face().planar()).equals(face().adjacentTo(face().planar()))).toBe(true);
    expect(face().adjacentTo(face().planar()).equals(face().notAdjacentTo(face().planar()))).toBe(false);
    expect(face().adjacentTo(edge().boundary()).equals(face().adjacentTo(face().planar()))).toBe(false);
    expect(face().adjacentTo(edge().boundary()).transform(Matrix4.fromTranslation(0, 0, 1)).equals(face().adjacentTo(edge().boundary()))).toBe(true);
  });

  it("declares a referenced feature as a dependency of the select()", () => {
    const e = box();
    const top = e.endFaces();
    const sel = select(face().adjacentTo(top)) as unknown as SelectSceneObject;
    expect(sel.getDependencies()).toContain(top);
    expect(() => face().adjacentTo()).toThrow(/adjacentTo\(\.\.\.refs\): name the faces or edges/);
  });
});
