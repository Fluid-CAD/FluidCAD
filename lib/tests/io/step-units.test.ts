import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import { FileExport } from "../../io/file-export.js";
import { OcIO } from "../../oc/io.js";
import { parseStepFileUnits } from "../../oc/step-units.js";
import { box, boundsOf, readStepBack, sceneSolids } from "./helpers.js";

const INCH_HEADER = `
ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#10 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#12 = ( CONVERSION_BASED_UNIT('INCH',#13) LENGTH_UNIT()
  NAMED_UNIT(#14) );
#13 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#10);
#15 = ( CONVERSION_BASED_UNIT('DEGREE',#16) NAMED_UNIT(#17) PLANE_ANGLE_UNIT() );
#18 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
ENDSEC;
END-ISO-10303-21;
`;

describe("STEP export units", () => {
  setupOC();

  for (const includeColors of [true, false]) {
    it(`writes a 1-inch box as 25.4 mm (colors ${includeColors ? "on" : "off"})`, () => {
      const solids = box(1);
      expect(boundsOf(solids[0].getShape()).max).toEqual([1, 1, 1]);

      const step = FileExport.exportShapes(solids, { format: "step", unit: "in", includeColors }).data as string;

      const back = boundsOf(readStepBack(step));
      expect(back.min).toEqual([0, 0, 0]);
      expect(back.max).toEqual([25.4, 25.4, 25.4]);

      // The file still declares MM (native INCH headers need Interface_Static,
      // which the binding does not expose); the numbers are what changed.
      expect(OcIO.readStepFileUnits(step)).toEqual({ length: ["MILLIMETRE"], angle: ["RADIAN"] });
    });
  }

  it("leaves an mm export unchanged", () => {
    const solids = box(10);
    const step = FileExport.exportShapes(solids, { format: "step", unit: "mm" }).data as string;
    expect(boundsOf(readStepBack(step)).max).toEqual([10, 10, 10]);

    // No unit at all still means mm, as before units existed.
    const plain = FileExport.exportShapes(solids, { format: "step" }).data as string;
    expect(boundsOf(readStepBack(plain)).max).toEqual([10, 10, 10]);
  });

  it("defaults the export unit to the scene's unit through SceneManager", () => {
    // A root document in inches: every solid's numbers are inches.
    getUnitRegistry().projectUnit = "in";
    const solids = box(2);
    const scene = getCurrentScene();
    expect(scene.unit).toBe("in");

    const step = getSceneManager().exportShapes(scene, solids.map(s => s.id), { format: "step" }).data as string;
    expect(boundsOf(readStepBack(step)).max).toEqual([50.8, 50.8, 50.8]);
    expect(sceneSolids().length).toBe(1);
  });

  it("reads the unit names a STEP file declares", () => {
    expect(parseStepFileUnits(INCH_HEADER)).toEqual({
      length: ["MILLIMETRE", "INCH"],
      angle: ["DEGREE", "RADIAN"],
    });
    expect(parseStepFileUnits("ISO-10303-21;\nDATA;\nENDSEC;")).toEqual({ length: [], angle: [] });
  });
});
