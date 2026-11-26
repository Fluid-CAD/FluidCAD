import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import type { TDocStd_Document, TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import { getOC } from "../../oc/init.js";
import { OcIO } from "../../oc/io.js";
import { FileExport } from "../../io/file-export.js";
import { FileImport, setAssetProvider } from "../../io/file-import.js";
import { LoadFile } from "../../features/load.js";
import load from "../../core/load.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import { circle } from "../../core/2d/index.js";
import { ShapeFactory } from "../../common/shape-factory.js";
import { Shape } from "../../common/shape.js";
import { Solid } from "../../common/solid.js";
import { Sheet } from "../../common/sheet.js";
import { Wire } from "../../common/wire.js";
import { Edge } from "../../common/edge.js";
import type { BodyShape } from "../../common/body-shape.js";
import type { ColoredBody } from "../../common/colored-body.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point } from "../../math/point.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { testRect } from "../helpers/profiles.js";
import { colorOf, faceColorEntriesOf, faceColorsOf } from "../utils.js";
import { sceneSolids, exportable, volumeOf } from "./helpers.js";

let workspace: string;

/** Bytes of STEP text, as an import reads them. */
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

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

/** Coloured STEP of `bodies` through the export writer. */
function stepOf(bodies: ColoredBody<BodyShape>[], unit: "mm" | "in" = "mm"): string {
  return FileExport.exportShapes(bodies, { format: "step", unit }).data as string;
}

/** The bodies `load(name)` adds, in the order it adds them, and the statement. */
function loadBodies(name: string, chain: (l: LoadFile) => void = () => {}): { bodies: Shape[]; statement: LoadFile } {
  const statement = load(name) as LoadFile;
  chain(statement);
  render();
  return { bodies: statement.getShapes(), statement };
}

function areaOf(shape: TopoDS_Shape): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/**
 * An XCAF document holding one free shape, the compound of `shapes` — what
 * a STEP reader hands over, without the file format deciding how each
 * kind of shape comes back.
 */
function withDocument<R>(shapes: TopoDS_Shape[], fn: (doc: TDocStd_Document) => R): R {
  const oc = getOC();
  const app = new oc.TDocStd_Application();
  const format = new oc.TCollection_ExtendedString("MDTV-XCAF");
  const doc = new oc.TDocStd_Document(format);
  app.InitDocument(doc);
  format.delete();
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main());
  const compound = OcIO.makeCompoundRaw(shapes);
  const label = shapeTool.NewShape();
  shapeTool.SetShape(label, compound);
  label.delete();
  try {
    return fn(doc);
  } finally {
    compound.delete();
    shapeTool.delete();
    doc.delete();
    app.delete();
  }
}

/**
 * A solid, an open five-face surface, a loose face, a three-edge wire and a
 * loose edge — one of each kind of body, apart from each other.
 */
function mixedShapes(): { shapes: Shape[]; dispose: () => void } {
  const shapes: Shape[] = [
    boxAt([100, 0, 0], 10),
    TestSheets.openBox(10, 10, 10),
    TestSheets.plate(5, 5),
    TestCurves.threeEdges(),
    EdgeOps.makeLineEdge(new Point(0, 0, 50), new Point(10, 0, 50)),
  ];
  return { shapes, dispose: () => shapes.forEach(s => s.dispose()) };
}

/** The bare face of a one-face sheet, as a loose face in a file. */
function looseFaceOf(sheet: Sheet): TopoDS_Shape {
  return sheet.getFaces()[0].getShape();
}

/** Writes an asset's `.brep` cache and colour sidecar by hand, as an import would have. */
function writeCache(name: string, bodies: Shape[], colors: unknown[]): void {
  fs.writeFileSync(join(workspace, "imports", `${name}.brep`), OcIO.writeBodiesAsBRep(bodies, `${name}.brep`));
  fs.writeFileSync(join(workspace, "imports", `${name}.colors.json`), JSON.stringify(colors, null, 2));
}

describe("STEP import of surfaces and curves", () => {
  setupOC();

  beforeAll(() => {
    workspace = fs.mkdtempSync(join(os.tmpdir(), "fluidcad-step-surfaces-"));
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

  it("imports a surface-only file as one surface, and load() adds it as a five-face Sheet", () => {
    const box = TestSheets.openBox(10, 10, 10);
    const step = stepOf([{ body: box, colors: [] }]);
    box.dispose();

    const result = FileImport.importFile(workspace, "surface.step", bytes(step));
    expect(result.contents).toEqual({ solids: 0, surfaces: 1, curves: 0 });
    expect(result.bodies.map(b => b.kind)).toEqual(["surface"]);
    const meta = FileImport.readImportMeta("surface");
    expect(meta?.contents).toEqual({ solids: 0, surfaces: 1, curves: 0 });

    const { bodies, statement } = loadBodies("surface");
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toBeInstanceOf(Sheet);
    expect((bodies[0] as Sheet).getFaces().length).toBe(5);
    expect(statement.serialize()).toEqual({ contents: { solids: 0, surfaces: 1, curves: 0 } });
  });

  describe("a mixed file", () => {
    it("is read in body order: solids, shells, loose faces, wires, loose edges", () => {
      const { shapes, dispose } = mixedShapes();
      try {
        const [solid, shell, plate, wire, edge] = shapes;
        const raw = [solid.getShape(), shell.getShape(), looseFaceOf(plate as Sheet), wire.getShape(), edge.getShape()];
        // Reversed, so the order comes from the walk, not from the file.
        const { bodies } = withDocument([...raw].reverse(), doc => OcIO.extractBodiesAndColors(doc));
        try {
          expect(bodies.map(b => b.kind)).toEqual(["solid", "surface", "surface", "curve", "curve"]);
          expect(bodies[0].shape).toBeInstanceOf(Solid);
          expect(bodies[1].shape).toBeInstanceOf(Sheet);
          expect((bodies[1].shape as Sheet).getFaces().length).toBe(5);
          // The loose face is wrapped as a surface of its own.
          expect(bodies[2].shape).toBeInstanceOf(Sheet);
          expect((bodies[2].shape as Sheet).getFaces().length).toBe(1);
          expect(bodies[3].shape).toBeInstanceOf(Wire);
          expect((bodies[3].shape as Wire).getEdges().length).toBe(3);
          expect(bodies[4].shape).toBeInstanceOf(Edge);
          expect(bodies.every(b => b.faceColors.length === 0)).toBe(true);
        } finally {
          bodies.forEach(b => b.shape.dispose());
        }
      } finally {
        dispose();
      }
    });

    it("loads from its cache as a Solid, two Sheets, a Wire and an Edge, and reports the counts", () => {
      const { shapes, dispose } = mixedShapes();
      try {
        writeCache("mixed", shapes, shapes.map(() => ({ faces: [] })));
      } finally {
        dispose();
      }
      const { bodies, statement } = loadBodies("mixed");
      expect(bodies.map(b => b.constructor)).toEqual([Solid, Sheet, Sheet, Wire, Edge]);
      expect((bodies[1] as Sheet).getFaces().length).toBe(5);
      expect((bodies[2] as Sheet).getFaces().length).toBe(1);
      expect(statement.serialize()).toEqual({ contents: { solids: 1, surfaces: 2, curves: 2 } });
    });

    it("keeps every kind's class when an inch document scales the cache", () => {
      const { shapes, dispose } = mixedShapes();
      try {
        writeCache("mixed-inch", shapes, shapes.map(() => ({ faces: [] })));
      } finally {
        dispose();
      }
      getUnitRegistry().projectUnit = "in";
      const { bodies } = loadBodies("mixed-inch");
      expect(bodies.map(b => b.constructor)).toEqual([Solid, Sheet, Sheet, Wire, Edge]);
      expect(volumeOf(bodies[0].getShape())).toBeCloseTo(1000 / 25.4 ** 3, 9);
      expect((bodies[3] as Wire).getEdges().length).toBe(3);
    });

    it("indexes bodies in body order: include(0) is the solid, exclude(1) drops the open shell only", () => {
      const { shapes, dispose } = mixedShapes();
      try {
        writeCache("indexed", shapes, shapes.map(() => ({ faces: [] })));
      } finally {
        dispose();
      }
      const only = loadBodies("indexed", l => l.include(0)).bodies;
      expect(only.map(b => b.constructor)).toEqual([Solid]);

      getSceneManager().startScene();
      const rest = loadBodies("indexed", l => l.exclude(1)).bodies;
      expect(rest.map(b => b.constructor)).toEqual([Solid, Sheet, Wire, Edge]);
      expect((rest[1] as Sheet).getFaces().length).toBe(1);
    });

    it("comes back from a STEP file with each kind in place; STEP keeps a wire as its separate edges", () => {
      const { shapes, dispose } = mixedShapes();
      let step: string;
      try {
        const [solid, shell, plate, wire, edge] = shapes;
        const compound = OcIO.makeCompoundRaw([solid.getShape(), shell.getShape(), looseFaceOf(plate as Sheet), wire.getShape(), edge.getShape()]);
        try {
          step = OcIO.writeStepRaw(compound, "mixed-raw.step");
        } finally {
          compound.delete();
        }
      } finally {
        dispose();
      }

      // A STEP curve set carries edges, not wires: the reader hands the
      // wire back as its three edges, each a curve of its own. The loose
      // face comes back inside a shell of its own.
      const result = FileImport.importFile(workspace, "mixed-raw.step", bytes(step));
      expect(result.bodies.map(b => b.kind)).toEqual(["solid", "surface", "surface", "curve", "curve", "curve", "curve"]);
      expect(result.contents).toEqual({ solids: 1, surfaces: 2, curves: 4 });

      const { bodies } = loadBodies("mixed-raw");
      expect(bodies.map(b => b.constructor)).toEqual([Solid, Sheet, Sheet, Edge, Edge, Edge, Edge]);
      expect((bodies[1] as Sheet).getFaces().length).toBe(5);
      expect((bodies[2] as Sheet).getFaces().length).toBe(1);
    });
  });

  it("keeps a surface's face colour through the import and records it on the load statement", () => {
    const box = TestSheets.openBox(10, 10, 10);
    const bottom = box.getFaces().find(face => Math.abs(face.center().z) < 1e-9)!;
    const step = stepOf([{ body: box, colors: [{ face: bottom, color: "#ff8800" }] }]);
    box.dispose();

    FileImport.importFile(workspace, "painted-surface.step", bytes(step));
    const sidecar = JSON.parse(fs.readFileSync(join(workspace, "imports", "painted-surface.colors.json"), "utf8"));
    expect(sidecar.length).toBe(1);
    expect(sidecar[0].faces.map((f: { color: string }) => f.color)).toEqual(["#ff8800"]);

    const { bodies, statement } = loadBodies("painted-surface");
    const sheet = bodies[0] as Sheet;
    const scene = getCurrentScene();
    const painted = [...faceColorsOf(scene, sheet)];
    expect(painted.length).toBe(1);
    const [face, hex] = painted[0];
    expect(hex).toBe("#ff8800");
    expect(face.center().z).toBeCloseTo(0, 9);
    expect(colorOf(scene, sheet, face)).toBe("#ff8800");
    expect(faceColorEntriesOf(scene, sheet).every(entry => entry.setBy === statement)).toBe(true);
  });

  it("loads a cache of two solids with a two-entry sidecar as those solids, with their colours", () => {
    // A cache holding solids alone: a compound of the two solids and one
    // sidecar entry per solid.
    const a = boxAt([0, 0, 0], 10);
    const b = boxAt([20, 0, 0], 5);
    const compound = OcIO.makeCompoundRaw([a.getShape(), b.getShape()]);
    try {
      fs.writeFileSync(join(workspace, "imports", "legacy-pair.brep"), OcIO.writeBRepRaw(compound, "legacy-pair.brep"));
    } finally {
      compound.delete();
      a.dispose();
      b.dispose();
    }
    fs.writeFileSync(join(workspace, "imports", "legacy-pair.colors.json"), JSON.stringify([
      { faces: [{ faceIndex: 0, color: "#112233" }] },
      { faces: [{ faceIndex: 2, color: "#445566" }, { faceIndex: 3, color: "#445566" }] },
    ], null, 2));

    const { bodies, statement } = loadBodies("legacy-pair");
    expect(bodies.map(s => s.constructor)).toEqual([Solid, Solid]);
    expect(volumeOf(bodies[0].getShape())).toBeCloseTo(1000, 6);
    expect(volumeOf(bodies[1].getShape())).toBeCloseTo(125, 6);
    const scene = getCurrentScene();
    expect([...faceColorsOf(scene, bodies[0]).values()]).toEqual(["#112233"]);
    expect([...faceColorsOf(scene, bodies[1]).values()]).toEqual(["#445566", "#445566"]);
    expect(statement.serialize()).toEqual({ contents: { solids: 2, surfaces: 0, curves: 0 } });
  });

  it("writes a solids-only file's cache as the compound of its solids, byte for byte, with `contents` the only addition", () => {
    sketch("xy", () => {
      testRect(10, 10, { at: [0, 0] });
    });
    const painted = extrude(10);
    color("#3366cc", painted);
    sketch("xy", () => {
      circle([40, 0], 10);
    });
    extrude(15);
    render();
    const step = bytes(FileExport.exportShapes(exportable(sceneSolids()), { format: "step" }).data as string);

    FileImport.importFile(workspace, "solids.step", step);
    const brep = fs.readFileSync(join(workspace, "imports", "solids.brep"), "utf8");

    // The cache of the file's solids alone: every free shape's solids, in
    // order, compounded and written.
    const oc = getOC();
    const { docHandle, cleanup } = OcIO.readStepXCAF("solids-only.step", step);
    const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(docHandle.Main());
    const free = new oc.TDF_LabelSequence();
    shapeTool.GetFreeShapes(free);
    const solids: TopoDS_Shape[] = [];
    for (let i = 1; i <= free.Length(); i++) {
      const label = free.Value(i);
      const root = oc.XCAFDoc_ShapeTool.GetShape(label);
      solids.push(...OcIO.findSolidsRaw(root));
      root.delete();
      label.delete();
    }
    const compound = OcIO.makeCompoundRaw(solids);
    const solidsOnly = OcIO.writeBRepRaw(compound, "solids-only.brep");
    compound.delete();
    solids.forEach(s => s.delete());
    free.delete();
    shapeTool.delete();
    cleanup();

    expect(brep).toBe(solidsOnly);
    const sixFaces = [0, 1, 2, 3, 4, 5].map(faceIndex => ({ faceIndex, color: "#3366cc" }));
    expect(fs.readFileSync(join(workspace, "imports", "solids.colors.json"), "utf8"))
      .toBe(JSON.stringify([{ faces: sixFaces }, { faces: [] }], null, 2));
    const meta = JSON.parse(fs.readFileSync(join(workspace, "imports", "solids.import.json"), "utf8"));
    expect(Object.keys(meta)).toEqual(["schemaVersion", "unit", "sourceUnits", "importedAt", "contents"]);
    expect(meta.contents).toEqual({ solids: 2, surfaces: 0, curves: 0 });
  });

  it("scales a surface with the document's unit, as a solid is scaled", () => {
    // An inch model: a 1 × 1 plate and a 1-inch cube, written physically
    // (the file holds 25.4 mm).
    const plate = TestSheets.plate(1, 1);
    const cube = boxAt([5, 0, 0], 1);
    const [plateFace] = plate.getFaces();
    const step = stepOf([{ body: cube, colors: [] }, { body: plate, colors: [{ face: plateFace, color: "#00aa00" }] }], "in");
    plate.dispose();
    cube.dispose();
    FileImport.importFile(workspace, "inch-model.step", bytes(step));

    const mm = loadBodies("inch-model").bodies;
    expect(mm.map(b => b.constructor)).toEqual([Solid, Sheet]);
    expect(volumeOf(mm[0].getShape())).toBeCloseTo(25.4 ** 3, 3);
    expect(areaOf(mm[1].getShape())).toBeCloseTo(25.4 ** 2, 6);

    // Loaded into an inch document the cache is scaled back: the surface
    // keeps its class and its painted face.
    getSceneManager().startScene();
    getUnitRegistry().projectUnit = "in";
    const inch = loadBodies("inch-model").bodies;
    expect(inch.map(b => b.constructor)).toEqual([Solid, Sheet]);
    expect(volumeOf(inch[0].getShape())).toBeCloseTo(1, 9);
    expect(areaOf(inch[1].getShape())).toBeCloseTo(1, 9);
    const sheet = inch[1] as Sheet;
    expect(colorOf(getCurrentScene(), sheet, sheet.getFaces()[0])).toBe("#00aa00");
  });

  it("round-trips a loaded surface through a STEP export and a new import", () => {
    const box = TestSheets.openBox(10, 20, 30);
    const step = stepOf([{ body: box, colors: [] }]);
    const area = areaOf(box.getShape());
    box.dispose();
    FileImport.importFile(workspace, "trip.step", bytes(step));

    const { bodies } = loadBodies("trip");
    const sheet = bodies[0] as Sheet;
    const exported = getSceneManager().exportShapes(getCurrentScene(), [sheet.id], { format: "step" }).data as string;

    const again = FileImport.importFile(workspace, "trip-again.step", bytes(exported));
    expect(again.contents).toEqual({ solids: 0, surfaces: 1, curves: 0 });
    const back = again.bodies[0].shape as Sheet;
    expect(back.getFaces().length).toBe(5);
    expect(areaOf(back.getShape())).toBeCloseTo(area, 6);
    expect(areaOf(back.getShape())).toBeCloseTo(10 * 20 + 2 * (10 * 30 + 20 * 30), 6);
  });
});
