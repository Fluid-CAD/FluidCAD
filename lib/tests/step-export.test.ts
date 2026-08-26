import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getCurrentScene } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import color from "../core/color.js";
import { circle } from "../core/2d/index.js";
import { FileExport } from "../io/file-export.js";
import { Solid } from "../common/solid.js";
import { Shape } from "../common/shape.js";
import { ISceneObject } from "../core/interfaces.js";
import { testRect } from "./helpers/profiles.js";

/** Every solid the scene would hand to an export, same walk as SceneManager. */
function sceneSolids(): Solid[] {
  const solids: Solid[] = [];
  for (const obj of getCurrentScene().getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes() as Shape[]) {
      if (shape.isSolid()) {
        solids.push(shape as Solid);
      }
    }
  }
  return solids;
}

function countOccurrences(text: string, entity: string): number {
  return text.split(entity).length - 1;
}

/** A plate and a separate cylindrical boss — two disjoint bodies. */
function twoBodies(): { plate: ISceneObject; boss: ISceneObject } {
  sketch("xy", () => {
      testRect(50, 30, { at: [-25, -15] });
    });
  const plate = extrude(6);

  sketch("xy", () => {
    circle([60, 0], 10);
  });
  const boss = extrude(15);

  return { plate, boss };
}

describe("STEP export", () => {
  setupOC();

  it("writes every solid, not just the first", () => {
    twoBodies();
    render();

    const solids = sceneSolids();
    expect(solids.length).toBe(2);

    const step = FileExport.exportShapes(solids, { format: "step" }).data as string;

    // The colored (XCAF) writer used to switch to multi-file mode and only one
    // of the split files came back, silently dropping the cylinder.
    expect(countOccurrences(step, "MANIFOLD_SOLID_BREP")).toBe(2);
    expect(countOccurrences(step, "CYLINDRICAL_SURFACE")).toBeGreaterThan(0);
  });

  it("keeps colors on a multi-solid export", () => {
    const { plate } = twoBodies();
    // A hex outside STEP's pre-defined names ("red", "blue", ...) so the
    // writer has to emit a COLOUR_RGB rather than a named colour.
    color("#3366cc", plate);
    render();

    const step = FileExport.exportShapes(sceneSolids(), { format: "step" }).data as string;

    expect(countOccurrences(step, "MANIFOLD_SOLID_BREP")).toBe(2);
    expect(step).toContain("COLOUR_RGB");
    expect(step).toContain("STYLED_ITEM");
  });

  it("writes every solid with colors off", () => {
    twoBodies();
    render();

    const step = FileExport.exportShapes(sceneSolids(), {
      format: "step",
      includeColors: false,
    }).data as string;

    expect(countOccurrences(step, "MANIFOLD_SOLID_BREP")).toBe(2);
  });
});
