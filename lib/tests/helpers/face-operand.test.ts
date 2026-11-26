import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import translate from "../../core/translate.js";
import plane from "../../core/plane.js";
import { line } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import { FaceOperand } from "../../helpers/face-operand.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { getCurrentScene } from "../../scene-manager.js";
import { TestSheets } from "./sheets.js";
import { TestCurves } from "./curves.js";
import { testRect } from "./profiles.js";
import { useLoadedBodies, loadShapes } from "./loaded-bodies.js";

const asObject = (value: unknown) => value as SceneObject;
const scope = () => getCurrentScene().getAllSceneObjects();

function refusal(run: () => unknown): BuildError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return error as BuildError;
  }
  throw new Error("expected a BuildError");
}

/** A 20 × 20 × 10 block and an open box surface (five faces) beside it. */
function blockAndSurface(): { block: SceneObject; surface: SceneObject } {
  sketch("xy", () => {
    testRect(20, 20, { at: [100, 0] });
  });
  const block = asObject(extrude(10));
  const surface = asObject(loadShapes([TestSheets.openBox(10, 10, 10)]));
  return { block, surface };
}

describe("FaceOperand", () => {
  setupOC();
  useLoadedBodies();

  describe("what an argument stands for", () => {
    it("a selection of faces: those faces, each on the body that has it", () => {
      const { block, surface } = blockAndSurface();
      const tops = asObject(select(face().planar().onPlane("xy", 10)));
      const surfaceFloor = asObject(select(face().ofSurface().onPlane("xy")));
      render();

      const held = FaceOperand.faces(tops, scope(), "target");
      expect(held.length).toBe(1);
      expect(held[0].body).toBeInstanceOf(Solid);
      expect(held[0].holder).toBe(block);

      const floor = FaceOperand.faces(surfaceFloor, scope(), "target");
      expect(floor.length).toBe(1);
      expect(floor[0].body).toBeInstanceOf(Sheet);
      expect(floor[0].holder).toBe(surface);
    });

    it("a surface: every face of it, whole", () => {
      const { surface } = blockAndSurface();
      render();

      const groups = FaceOperand.byBody(surface, scope(), "target");
      expect(groups.length).toBe(1);
      expect(groups[0].body).toBeInstanceOf(Sheet);
      expect(groups[0].faces.length).toBe(5);
      expect(groups[0].whole).toBe(true);
      expect(groups[0].holder).toBe(surface);
    });

    it("a solid: every face of it, whole", () => {
      const { block } = blockAndSurface();
      render();

      const groups = FaceOperand.byBody(block, scope(), "target");
      expect(groups.map(g => [g.body.constructor, g.faces.length, g.whole])).toEqual([[Solid, 6, true]]);
    });

    it("a face no body in scope holds: the face, with no owner", () => {
      blockAndSurface();
      const tops = asObject(select(face().planar().onPlane("xy", 10)));
      render();

      const held = FaceOperand.faces(tops, [], "target");
      expect(held.map(h => [h.body, h.holder])).toEqual([[null, null]]);
      expect(refusal(() => FaceOperand.byBody(tops, [], "target")).diagnostic)
        .toBe("target: no solid or surface in scope holds a selected face.");
    });

    it("a plane datum stands for no face: meta shapes never count", () => {
      const datum = asObject(plane("xy", 5));
      render();

      expect(FaceOperand.faces(datum, scope(), "target")).toEqual([]);
    });

    it("edges, a sketch or a curve are refused, naming what was given", () => {
      const s = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
      }));
      const { block } = blockAndSurface();
      const curve = asObject(loadShapes([TestCurves.threeEdges()]));
      const rims = asObject(select(edge().from(block).line()));
      render();

      expect(refusal(() => FaceOperand.faces(s, scope(), "target")).diagnostic).toBe("target is a sketch; it needs faces.");
      expect(refusal(() => FaceOperand.faces(curve, scope(), "target")).diagnostic).toBe("target is a curve; it needs faces.");
      expect(refusal(() => FaceOperand.faces(rims, scope(), "target")).diagnostic).toBe("target is an edge selection; it needs faces.");
    });
  });

  it("a face is matched to its body after the body was translated", () => {
    const { block } = blockAndSurface();
    const moved = asObject(translate([0, 50, 0], block));
    const tops = asObject(select(face().ofSolid().onPlane("xy", 10)));
    render();

    const [held] = FaceOperand.faces(tops, scope(), "target");
    expect(held.holder).toBe(moved);
    expect(ShapeOps.getBoundingBox(held.body!).centerY).toBeCloseTo(60, 6);

    // The object that built the block names it where the move left it.
    const groups = FaceOperand.byBody(block, scope(), "target");
    expect(groups.map(g => [g.holder, g.whole])).toEqual([[moved, true]]);
  });

  it("orders bodies by scene order and lists each face once", () => {
    const { block, surface } = blockAndSurface();
    render();

    const groups = FaceOperand.byBody([surface, block, surface], scope(), "target");
    expect(groups.map(g => g.holder)).toEqual([block, surface]);
    expect(groups.map(g => g.faces.length)).toEqual([6, 5]);
  });

  describe("sheets", () => {
    it("takes a whole surface, by its object or by all its faces", () => {
      const { surface } = blockAndSurface();
      const allFaces = asObject(select(face().ofSurface()));
      render();

      for (const source of [surface, allFaces]) {
        const sheets = FaceOperand.sheets(source, scope(), "target");
        expect(sheets.length).toBe(1);
        expect(sheets[0].sheet).toBeInstanceOf(Sheet);
        expect(sheets[0].holder).toBe(surface);
      }
    });

    it("refuses a solid and part of a surface", () => {
      const { block } = blockAndSurface();
      const floor = asObject(select(face().ofSurface().onPlane("xy")));
      render();

      expect(refusal(() => FaceOperand.sheets(block, scope(), "target")).diagnostic)
        .toBe("target is a solid; it needs a surface.");
      expect(refusal(() => FaceOperand.sheets(floor, scope(), "target")).diagnostic)
        .toBe("target names 1 of the 5 faces of a surface; it needs the whole surface.");
    });
  });
});
