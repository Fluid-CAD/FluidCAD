import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import { operandKindError, operandKindOf, requireShapes } from "../../common/operand-check.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";

const asObject = (value: unknown) => value as SceneObject;

function refusal(run: () => unknown): BuildError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return error as BuildError;
  }
  throw new Error("expected a BuildError");
}

describe("requireShapes kinds", () => {
  setupOC();
  useLoadedBodies();

  it("tells a solid, a surface and a curve apart", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const e = asObject(extrude(10));
    const l = asObject(loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]));
    render();

    expect(operandKindOf(e.getShapes()[0])).toBe("solid");
    expect(l.getShapes().map(operandKindOf)).toEqual(["surface", "curve"]);
    expect(requireShapes(e, "target", "fuse", { kinds: "solid" }).length).toBe(1);
    expect(requireShapes(l, "target", "move", { kinds: ["surface", "curve"] }).length).toBe(2);
  });

  it("refuses a surface where a solid is needed, naming the operand", () => {
    const l = asObject(loadShapes([TestSheets.plate(10, 10)]));
    render();

    const error = refusal(() => requireShapes(l, "second operand", "fuse", { kinds: "solid", kindHint: "Thicken it first." }));
    expect(error.diagnostic).toBe("fuse: second operand is a surface; fuse works on solids.");
    expect(error.hint).toBe("Thicken it first.");
  });

  it("refuses a face selection with the face named, and words a default hint", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    extrude(10);
    const faces = asObject(select(face().planar()));
    render();

    const error = refusal(() => requireShapes(faces, "target", "thicken", { kinds: ["surface"] }));
    expect(error.diagnostic).toBe("thicken: target is a face; thicken works on surfaces.");
    expect(error.hint).toBe("Pass a surface as target.");
  });

  it("builds the same wording for a feature that checks by itself", () => {
    const error = operandKindError("fillet", "edge selection", "edge", ["solid"], "Add .ofSolid() to the filter.");
    expect(error.diagnostic).toBe("fillet: edge selection is an edge; fillet works on solids.");
    expect(error.message).toContain("Hint: Add .ofSolid() to the filter.");
  });
});
