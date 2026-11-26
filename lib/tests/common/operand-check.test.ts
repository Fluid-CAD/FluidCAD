import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import {
  isSolidReshaper, offSolidPart, offSolidRefusal, operandKindError, operandKindOf, refuseOffSolidParts, requireShapes,
} from "../../common/operand-check.js";
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

  it("names the tools that reshape solids, and what a part off a solid reads as", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const e = asObject(extrude(10));
    const l = asObject(loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]));
    render();
    const [surface, curve] = l.getShapes();

    expect(["fillet", "chamfer", "shell", "draft"].every(isSolidReshaper)).toBe(true);
    expect(["extrude", "color", "sweep", "toString"].some(isSolidReshaper)).toBe(false);
    expect(offSolidPart(e.getShapes()[0], "edge")).toBeNull();
    expect(offSolidPart(surface, "edge")).toBe("surface edge");
    expect(offSolidPart(surface, "face")).toBe("surface face");
    expect(offSolidPart(curve, "edge")).toBe("curve edge");
  });

  it("refuses a selection off a solid in one wording, counting the tool's selections from 1", () => {
    expect(offSolidRefusal("fillet", "surface edge").diagnostic).toBe("fillet: edge selection 1 holds a surface edge; fillet works on solids.");
    expect(offSolidRefusal("shell", "surface face", 1).diagnostic).toBe("shell: face selection 2 holds a surface face; shell works on solids.");
    expect(offSolidRefusal("draft", "surface face").diagnostic).toBe("draft: selection 1 holds a surface face; draft works on solids.");
    expect(offSolidRefusal("chamfer", "curve edge").hint).toContain(".ofSolid()");
  });

  it("finds a selection's edges on a surface or a curve in reach, and leaves a solid's alone", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [100, 0] });
    });
    const e = asObject(extrude(10));
    const l = asObject(loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]));
    render();
    const [surface, curve] = l.getShapes();
    const scope = [e, l];

    expect(() => refuseOffSolidParts("fillet", 0, e.getShapes()[0].getSubShapes("edge"), scope)).not.toThrow();
    expect(refusal(() => refuseOffSolidParts("fillet", 0, surface.getSubShapes("edge"), scope)).diagnostic)
      .toBe("fillet: edge selection 1 holds a surface edge; fillet works on solids.");
    expect(refusal(() => refuseOffSolidParts("chamfer", 2, curve.getSubShapes("edge"), scope)).diagnostic)
      .toBe("chamfer: edge selection 3 holds a curve edge; chamfer works on solids.");
    expect(refusal(() => refuseOffSolidParts("fillet", 0, [curve], scope)).diagnostic)
      .toBe("fillet: edge selection 1 holds a curve; fillet works on solids.");
    // An edge nothing in reach holds is left to the build, which reports what it could not match.
    expect(() => refuseOffSolidParts("fillet", 0, curve.getSubShapes("edge"), [e])).not.toThrow();
  });

  it("builds the same wording for a feature that checks by itself", () => {
    const error = operandKindError("fillet", "edge selection", "edge", ["solid"], "Add .ofSolid() to the filter.");
    expect(error.diagnostic).toBe("fillet: edge selection is an edge; fillet works on solids.");
    expect(error.message).toContain("Hint: Add .ofSolid() to the filter.");
  });
});
