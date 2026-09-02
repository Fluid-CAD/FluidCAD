import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { setupOC, render } from "../setup.js";
import { getUnitRegistry } from "../../units/registry.js";
import { getSceneManager } from "../../scene-manager.js";
import { FileExport } from "../../io/file-export.js";
import { FileImport, setAssetProvider } from "../../io/file-import.js";
import load from "../../core/load.js";
import color from "../../core/color.js";
import { sceneSolids, volumeOf } from "./helpers.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { testRect } from "../helpers/profiles.js";
import { Solid } from "../../common/solid.js";
import { LoadFile } from "../../features/load.js";

const IN3 = 25.4 ** 3;

let workspace: string;
let stepBytes: Uint8Array;

function importBox(name: string): void {
  FileImport.importFile(workspace, `${name}.step`, stepBytes);
}

function loadedSolids(): Solid[] {
  render();
  return sceneSolids();
}

describe("load() units", () => {
  setupOC();

  beforeAll(() => {
    workspace = fs.mkdtempSync(join(os.tmpdir(), "fluidcad-load-units-"));
    fs.mkdirSync(join(workspace, "imports"));
    // load() reads assets through the provider, so the scene manager's root
    // path (a shared /tmp dir) never sees these files.
    setAssetProvider(rel => {
      const file = join(workspace, rel);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    });
  });

  afterAll(() => {
    setAssetProvider(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (stepBytes) {
      return;
    }
    // A painted 10 mm box, exported once and reused as the STEP fixture.
    // (One render only: color() wraps the body in its own scene object.)
    getSceneManager().startScene();
    sketch("xy", () => {
      testRect(10, 10, { at: [0, 0] });
    });
    const body = extrude(10);
    color("#3366cc", body);
    render();
    const solids = sceneSolids().filter(s => s.colorMap.length > 0);
    expect(solids.length).toBe(1);
    stepBytes = new TextEncoder().encode(FileExport.exportShapes(solids, { format: "step" }).data as string);
    getSceneManager().startScene();
  });

  it("caches the import in mm with a sidecar naming the file's units", () => {
    const result = FileImport.importFile(workspace, "meta.step", stepBytes);
    expect(result.unit).toBe("mm");
    expect(result.solids.length).toBe(1);
    expect(result.sourceUnits).toEqual({ length: ["MILLIMETRE"], angle: ["RADIAN"] });

    const meta = JSON.parse(fs.readFileSync(join(workspace, "imports", "meta.import.json"), "utf8"));
    expect(meta.schemaVersion).toBe(1);
    expect(meta.unit).toBe("mm");
    expect(meta.sourceUnits).toEqual(result.sourceUnits);
    expect(typeof meta.importedAt).toBe("string");
    // The colour sidecar keeps its old shape: a bare array indexed by solid.
    const colors = JSON.parse(fs.readFileSync(join(workspace, "imports", "meta.colors.json"), "utf8"));
    expect(Array.isArray(colors)).toBe(true);
    expect(FileImport.readAssetUnit("meta")).toBe("mm");
  });

  it("loads an mm asset into an mm document unscaled", () => {
    importBox("mmbox");
    load("mmbox");
    const [solid] = loadedSolids();
    expect(volumeOf(solid.getShape())).toBeCloseTo(1000, 6);
  });

  it("scales an mm asset into an inch document", () => {
    importBox("inbox");
    getUnitRegistry().projectUnit = "in";
    load("inbox");
    const [solid] = loadedSolids();
    expect(volumeOf(solid.getShape())).toBeCloseTo(1000 / IN3, 9);
  });

  it("honours a { unit } assertion over the sidecar", () => {
    importBox("assert");
    load("assert", { unit: "in" });
    const [solid] = loadedSolids();
    expect(volumeOf(solid.getShape())).toBeCloseTo(1000 * IN3, 3);
  });

  it("accepts unit aliases and rejects unknown units", () => {
    importBox("alias");
    expect(() => load("alias", { unit: "inches" })).not.toThrow();
    expect(() => load("alias", { unit: "furlong" })).toThrow(/load\(\): Unknown length unit 'furlong'/);
  });

  it("treats an asset without a sidecar as mm", () => {
    importBox("legacy");
    fs.rmSync(join(workspace, "imports", "legacy.import.json"));
    expect(FileImport.readAssetUnit("legacy")).toBe("mm");
    getUnitRegistry().projectUnit = "in";
    load("legacy");
    const [solid] = loadedSolids();
    expect(volumeOf(solid.getShape())).toBeCloseTo(1000 / IN3, 9);
  });

  it("keeps face colours on the scaled solid", () => {
    importBox("painted");
    getUnitRegistry().projectUnit = "in";
    load("painted");
    const [solid] = loadedSolids();
    const faces = solid.getFaces();
    expect(faces.length).toBe(6);
    expect(solid.colorMap.length).toBe(6);
    for (const face of faces) {
      expect(solid.getColor(face.getShape())).toBe("#3366cc");
    }
  });

  it("rebuilds when the document's unit changes", () => {
    importBox("cmp");
    const a = load("cmp") as LoadFile;
    const b = load("cmp") as LoadFile;
    expect(a.compareTo(b)).toBe(true);
    const c = load("cmp", { unit: "in" }) as LoadFile;
    expect(a.compareTo(c)).toBe(false);
  });
});
