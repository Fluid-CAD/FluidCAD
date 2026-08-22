import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getCurrentScene } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import revolve from "../core/revolve.js";
import fillet from "../core/fillet.js";
import select from "../core/select.js";
import repeat from "../core/repeat.js";
import color from "../core/color.js";
import { edge } from "../filters/index.js";
import { rect, circle, line, move } from "../core/2d/index.js";
import { FileExport } from "../io/file-export.js";
import { OcIO } from "../oc/io.js";
import { getOC } from "../oc/init.js";
import { Solid } from "../common/solid.js";
import { Shape } from "../common/shape.js";
import { ISceneObject } from "../core/interfaces.js";

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
    rect(50, 30).centered();
  });
  const plate = extrude(6);

  sketch("xy", () => {
    circle([60, 0], 10);
  });
  const boss = extrude(15);

  return { plate, boss };
}

/**
 * The snap-on can lid from Fluid-CAD/FluidCAD#61: a revolved line profile
 * whose inward-leaning segments become cones with a NEGATIVE semi-angle —
 * legal in OCCT, illegal in STEP — plus fillets and a ring of revolved ribs.
 */
function canLid(): void {
  const lipR = 29.1, seatR = 29.7, skirtR = 30.9, bulgeR = 31.3, roofInnerR = 27.6;
  const lipH = 3.2, seatZ0 = 3.9, seatZ1 = 7.4, roofZ = 8.6, topZ = 10.2, bulgeZ1 = 7.5, bulgeZ0 = 3.6;
  sketch("xz", () => {
    line([lipR + 0.7, 0], [lipR, 0.9]);
    line([lipR, lipH]);
    line([seatR, seatZ0]);
    line([seatR, seatZ1]);
    line([roofInnerR, roofZ]);
    line([0, roofZ]);
    line([0, topZ]);
    line([bulgeR, topZ]);
    line([bulgeR, bulgeZ1]);
    line([skirtR, bulgeZ0]);
    line([skirtR, 0]);
    line([lipR + 0.7, 0]);
  });
  revolve("z");
  select(edge().circle(bulgeR * 2));
  fillet(1.2);
  select(edge().circle(skirtR * 2));
  fillet(1.0);

  sketch("xz", () => {
    move([skirtR - 0.4, 0.8]);
    rect(1.0, 2.4).radius(0.4);
  });
  const rib = revolve("z", 2.4);
  repeat("circular", "z", { count: 24, angle: 360 }, rib);
}

/** Reads `step` back and reports what the file actually describes. */
function readBack(step: string): { faces: number; solids: number; valid: boolean; volume: number } {
  const oc = getOC();
  const shape = OcIO.readStepRaw("readback.step", new TextEncoder().encode(step));
  const count = (type: unknown) => {
    const explorer = new oc.TopExp_Explorer(shape, type as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let n = 0;
    for (; explorer.More(); explorer.Next()) {
      n++;
    }
    explorer.delete();
    return n;
  };
  const checker = new oc.BRepCheck_Analyzer(shape, true, true);
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  const result = {
    faces: count(oc.TopAbs_ShapeEnum.TopAbs_FACE),
    solids: count(oc.TopAbs_ShapeEnum.TopAbs_SOLID),
    valid: checker.IsValid(),
    volume: props.Mass(),
  };
  checker.delete();
  props.delete();
  return result;
}

function volumeOf(solid: Solid): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(solid.getShape(), props, false, false, false);
  const volume = props.Mass();
  props.delete();
  return volume;
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

  // Fluid-CAD/FluidCAD#61: OCCT's writer throws on cones with a negative
  // semi-angle and drops the face, so a revolved profile came back with
  // holes in its MANIFOLD_SOLID_BREP (both with and without colors).
  for (const includeColors of [true, false]) {
    it(`keeps every face of a revolve with inward-leaning cones (colors ${includeColors ? "on" : "off"})`, () => {
      canLid();
      render();

      // The lid plus its 24 ribs: the repeat leaves each rib its own body.
      const solids = sceneSolids();
      expect(solids.length).toBeGreaterThan(1);
      const faceCount = solids.reduce((n, solid) => n + solid.getFaces().length, 0);
      const volume = solids.reduce((v, solid) => v + volumeOf(solid), 0);

      const step = FileExport.exportShapes(solids, { format: "step", includeColors }).data as string;
      expect(countOccurrences(step, "ADVANCED_FACE")).toBe(faceCount);
      expect(step).not.toContain("SURFACE_OF_REVOLUTION");

      const back = readBack(step);
      expect(back.solids).toBe(solids.length);
      expect(back.faces).toBe(faceCount);
      expect(back.valid).toBe(true);
      expect(back.volume).toBeCloseTo(volume, 3);
    });
  }

  it("keeps a color painted on a rebuilt cone face", () => {
    sketch("xz", () => {
      line([20, 0], [30, 0]);
      line([25, 10]); // leans toward the axis: a negative-semi-angle cone
      line([20, 10]);
      line([20, 0]);
    });
    const body = revolve("z");
    color("#3366cc", body);
    render();

    // color() wraps the body in its own scene object; export the painted copy.
    const painted = sceneSolids().filter(solid => solid.colorMap.length > 0);
    expect(painted.length).toBe(1);
    const faceCount = painted[0].getFaces().length;
    expect(painted[0].colorMap.length).toBe(faceCount);

    const step = FileExport.exportShapes(painted, { format: "step" }).data as string;
    expect(countOccurrences(step, "ADVANCED_FACE")).toBe(faceCount);
    expect(countOccurrences(step, "CONICAL_SURFACE(")).toBe(1);
    expect(step).toContain("COLOUR_RGB");
    // Whole-body color: one STYLED_ITEM per face, the rebuilt cone included.
    expect(countOccurrences(step, "STYLED_ITEM(")).toBe(faceCount);
  });
});
