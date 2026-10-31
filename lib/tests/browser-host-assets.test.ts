// A share link carries the asset files a model's render read beside its
// source (GET /api/share-files): the viewer installs the whole tree with
// setWorkspace, and the engine reads a load()'s imported geometry out of it
// through the asset provider — no filesystem, as in the browser.

import { describe, it, expect, afterAll } from "vitest";
import { BrowserEngineHost } from "../browser/index.js";
import { setAssetProvider } from "../io/file-import.js";
import { getOC } from "../oc/init.js";
import { OcIO } from "../oc/io.js";
import load from "../core/load.js";

interface RenderedMesh { vertices: number[] }
interface RenderedObject { sceneShapes?: { meshes?: RenderedMesh[] }[] }

/** The rendered vertices' extent along each axis. */
function extents(result: unknown[]): [number, number, number] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const obj of result as RenderedObject[]) {
    for (const shape of obj.sceneShapes ?? []) {
      for (const mesh of shape.meshes ?? []) {
        for (let i = 0; i < mesh.vertices.length; i++) {
          min[i % 3] = Math.min(min[i % 3], mesh.vertices[i]);
          max[i % 3] = Math.max(max[i % 3], mesh.vertices[i]);
        }
      }
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** A 10 × 20 × 30 box as the `.brep` text an import caches in `imports/`. */
function boxBrep(): string {
  const oc = getOC();
  const maker = new oc.BRepPrimAPI_MakeBox(10, 20, 30);
  const shape = maker.Shape();
  maker.delete();
  try {
    return OcIO.writeBRepRaw(shape, "box.brep");
  } finally {
    shape.delete();
  }
}

const loadsBox = async () => {
  load("box.step");
  return {};
};

/**
 * Render with Node's `Buffer` out of reach, as in the viewer's browser
 * worker: an asset read that leans on it fails there and only there.
 */
async function renderWithoutBuffer(host: BrowserEngineHost) {
  const buffer = Object.getOwnPropertyDescriptor(globalThis, "Buffer")!;
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    return await host.render();
  } finally {
    Object.defineProperty(globalThis, "Buffer", buffer);
  }
}

describe("BrowserEngineHost — a shared tree's imported geometry", () => {
  afterAll(() => {
    setAssetProvider(null);
  });

  it("renders a load() from the .brep and sidecars the tree carries, with no Node Buffer", async () => {
    const host = new BrowserEngineHost();
    await host.init();
    host.setWorkspace({
      "model.fluid.js": "load('box.step');",
      "imports/box.brep": boxBrep(),
      "imports/box.colors.json": "[]",
      "imports/box.import.json": JSON.stringify({ schemaVersion: 1, unit: "mm", sourceUnits: { length: ["MILLIMETRE"], angle: [] }, importedAt: "2026-10-31T00:00:00.000Z" }),
    }, "model.fluid.js");
    host.setModuleEvaluator(loadsBox);

    const outcome = await renderWithoutBuffer(host);

    expect(outcome.compileError).toBeNull();
    expect(outcome.objectErrors).toEqual([]);
    const [x, y, z] = extents(outcome.result);
    expect(x).toBeCloseTo(10, 3);
    expect(y).toBeCloseTo(20, 3);
    expect(z).toBeCloseTo(30, 3);
  });

  it("fails the load() on its own row when the tree lacks the .brep", async () => {
    const host = new BrowserEngineHost();
    await host.init();
    host.setWorkspace({ "model.fluid.js": "load('box.step');" }, "model.fluid.js");
    host.setModuleEvaluator(loadsBox);

    const outcome = await host.render();

    expect(outcome.compileError).toBeNull();
    expect(outcome.objectErrors.map((error) => error.message)).toEqual(["Imported asset not found: imports/box.brep"]);
  });
});
