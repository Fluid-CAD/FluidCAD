import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { getOC } from "../../oc/init.js";
import { OcIO } from "../../oc/io.js";
import { FileExport } from "../../io/file-export.js";
import { FileImport, setAssetProvider } from "../../io/file-import.js";
import load from "../../core/load.js";
import type { LoadFile } from "../../features/load.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { Solid } from "../../common/solid.js";
import type { Shape } from "../../common/shape.js";
import type { BodyShape } from "../../common/body-shape.js";
import type { ColoredBody } from "../../common/colored-body.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point } from "../../math/point.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { boundsOf, stlBounds } from "./helpers.js";

let workspace: string;

/** A `size`³ box with its lowest corner at `corner`, built straight from the kernel. */
function boxAt(corner: [number, number, number], size: number): Solid {
  const oc = getOC();
  const point = new oc.gp_Pnt(...corner);
  const maker = new oc.BRepPrimAPI_MakeBox(point, size, size, size);
  try {
    return ShapeFactory.adopt(maker.Shape()) as Solid;
  } finally {
    maker.delete();
    point.delete();
  }
}

/** Unpainted bodies, as an export takes them. */
const plain = (...bodies: BodyShape[]): ColoredBody<BodyShape>[] => bodies.map(body => ({ body, colors: [] }));

/** What a STEP file holds once imported again. */
function reimport(step: string, name: string) {
  return FileImport.importFile(workspace, `${name}.step`, new TextEncoder().encode(step));
}

describe("export of solids and surfaces", () => {
  setupOC();

  beforeAll(() => {
    workspace = fs.mkdtempSync(join(os.tmpdir(), "fluidcad-export-bodies-"));
    fs.mkdirSync(join(workspace, "imports"));
    setAssetProvider(rel => {
      const file = join(workspace, rel);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    });
  });

  afterAll(() => {
    setAssetProvider(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  for (const includeColors of [true, false]) {
    it(`writes a solid and a surface to STEP, which imports again as one of each (colors ${includeColors ? "on" : "off"})`, () => {
      const solid = boxAt([100, 0, 0], 10);
      const surface = TestSheets.openBox(10, 10, 10);
      try {
        const result = FileExport.exportShapes(plain(solid, surface), { format: "step", includeColors });
        expect(result.warnings).toBeUndefined();
        const back = reimport(result.data as string, `pair-${includeColors}`);
        expect(back.contents).toEqual({ solids: 1, surfaces: 1, curves: 0 });
        expect(back.bodies.map(b => b.kind)).toEqual(["solid", "surface"]);
      } finally {
        solid.dispose();
        surface.dispose();
      }
    });
  }

  it("writes the solid alone to STL and says one surface was left out", () => {
    const solid = boxAt([100, 0, 0], 10);
    const surface = TestSheets.openBox(10, 10, 10);
    try {
      const result = FileExport.exportShapes(plain(solid, surface), { format: "stl" });
      expect(result.warnings).toEqual(["1 surface left out: a surface encloses no volume."]);
      // The mesh spans the solid only: the surface sits elsewhere.
      const bounds = stlBounds(result.data as Uint8Array);
      expect(bounds.min[0]).toBeCloseTo(100, 4);
      expect(bounds.max[0]).toBeCloseTo(110, 4);
    } finally {
      solid.dispose();
      surface.dispose();
    }
  });

  it("counts every surface it leaves out of a drawing", () => {
    const solid = boxAt([100, 0, 0], 10);
    const a = TestSheets.openBox(10, 10, 10);
    const b = TestSheets.plate(5, 5);
    try {
      const result = FileExport.exportShapes(plain(solid, a, b), { format: "dxf", plane: "top" });
      expect(result.warnings).toContain("2 surfaces left out: a surface encloses no volume.");
    } finally {
      [solid, a, b].forEach(s => s.dispose());
    }
  });

  it("refuses an STL of surfaces alone, pointing to STEP", () => {
    const surface = TestSheets.openBox(10, 10, 10);
    try {
      expect(() => FileExport.exportShapes(plain(surface), { format: "stl" })).toThrow(/STL cannot hold a surface[\s\S]*Export surfaces as STEP/);
      expect(() => FileExport.exportShapes(plain(surface), { format: "svg", plane: "top" })).toThrow(/as STEP/);
    } finally {
      surface.dispose();
    }
  });

  it("never writes a curve: a scene's curves stay out of a STEP export", () => {
    // An asset holding a solid, a wire and an edge, loaded into the scene.
    const shapes: Shape[] = [
      boxAt([0, 0, 0], 10),
      TestCurves.threeEdges(),
      EdgeOps.makeLineEdge(new Point(0, 0, 50), new Point(10, 0, 50)),
    ];
    try {
      fs.writeFileSync(join(workspace, "imports", "with-curves.brep"), OcIO.writeBodiesAsBRep(shapes, "with-curves.brep"));
      fs.writeFileSync(join(workspace, "imports", "with-curves.colors.json"), JSON.stringify(shapes.map(() => ({ faces: [] }))));
    } finally {
      shapes.forEach(s => s.dispose());
    }
    const statement = load("with-curves") as LoadFile;
    render();
    const ids = statement.getShapes().map(s => s.id);
    expect(ids.length).toBe(3);

    const scene = getCurrentScene();
    const step = getSceneManager().exportShapes(scene, ids, { format: "step" }).data as string;
    const back = reimport(step, "curves-back");
    expect(back.contents).toEqual({ solids: 1, surfaces: 0, curves: 0 });
    expect(boundsOf(back.bodies[0].shape.getShape()).max).toEqual([10, 10, 10]);

    // Curves alone are nothing to export.
    expect(() => getSceneManager().exportShapes(scene, ids.slice(1), { format: "step" }))
      .toThrow(/Nothing to export: no solid or surface matches/);
  });
});
