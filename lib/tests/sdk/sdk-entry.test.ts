import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import * as sdk from "../../sdk/index.js";
import * as kernel from "../../sdk/kernel.js";
import * as occt from "../../sdk/occt.js";
import { registerBuilder } from "../../index.js";
import { ENGINE_NAMESPACE_SPECIFIERS, engineShimModuleSource } from "../../browser/index.js";

const PACKAGE_JSON = path.resolve(import.meta.dirname, "../../../package.json");

/** Package subpaths no model imports: the server, the browser host itself, the viewer bundle. */
const HOST_ONLY_EXPORTS = ["./server", "./server/api", "./browser", "./viewer-ui", "./viewer-ui/style.css"];

describe("the fluidcad/sdk entry points", () => {
  it("export Feature, defineFeature, registerBuilder and parseCall, never SceneObject", () => {
    expect(Object.keys(sdk).sort()).toEqual(["Feature", "defineFeature", "parseCall", "registerBuilder"]);
    expect(sdk.registerBuilder).toBe(registerBuilder);
    expect(Object.keys(kernel)).not.toContain("SceneObject");
  });

  it("keep the unstable kernel to the surface the standoff builds with, and the wrappers raw shapes come back into", () => {
    expect(Object.keys(kernel).sort()).toEqual([
      "BooleanOps", "Edge", "Face", "Primitives", "Shape", "ShapeFactory", "ShapeOps", "Solid", "Vertex", "Wire",
    ]);
  });

  it("keep raw OpenCascade to its own entry: the instance and the scope its code runs in", () => {
    expect(Object.keys(occt).sort()).toEqual(["OccScope", "getOC"]);
    expect(Object.keys(sdk)).not.toContain("getOC");
    expect(Object.keys(kernel)).not.toContain("getOC");
  });

  it("link in the browser host like every other engine namespace", () => {
    expect(ENGINE_NAMESPACE_SPECIFIERS).toContain("fluidcad/sdk");
    expect(ENGINE_NAMESPACE_SPECIFIERS).toContain("fluidcad/sdk/kernel");
    expect(ENGINE_NAMESPACE_SPECIFIERS).toContain("fluidcad/sdk/occt");
    expect(engineShimModuleSource("fluidcad/sdk")).toContain("export const Feature =");
    expect(engineShimModuleSource("fluidcad/sdk")).toContain("export const defineFeature =");
    expect(engineShimModuleSource("fluidcad/sdk/kernel")).toContain("export const Primitives =");
    expect(engineShimModuleSource("fluidcad/sdk/occt")).toContain("export const OccScope =");
  });

  it("are what the browser host links: every model-facing package export, and nothing else", () => {
    const exportsMap = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).exports as Record<string, string>;
    const modelFacing = Object.keys(exportsMap)
      .filter(subpath => !HOST_ONLY_EXPORTS.includes(subpath))
      .map(subpath => subpath === "." ? "fluidcad" : `fluidcad/${subpath.slice(2)}`);
    expect([...ENGINE_NAMESPACE_SPECIFIERS].sort()).toEqual(modelFacing.sort());
  });
});
