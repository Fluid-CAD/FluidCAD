import { describe, it, expect } from "vitest";
import { BrowserEngineHost, engineShimModuleSource, VIEWER_PROTOCOL_VERSION } from "../browser/index.js";
import { param } from "../core/index.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import fillet from "../core/fillet.js";
import { line, arc } from "../core/2d/index.js";
import { coincident } from "../core/constraints/index.js";

interface RenderedMesh { vertices: number[] }
interface RenderedShape { meshes: RenderedMesh[] }
interface RenderedObject { sceneShapes?: RenderedShape[]; fromCache?: boolean }

function maxAbsX(result: unknown[]): number {
  let max = 0;
  for (const obj of result as RenderedObject[]) {
    for (const shape of obj.sceneShapes ?? []) {
      for (const mesh of shape.meshes ?? []) {
        for (let i = 0; i < mesh.vertices.length; i += 3) {
          max = Math.max(max, Math.abs(mesh.vertices[i]));
        }
      }
    }
  }
  return max;
}

function totalMeshes(result: unknown[]): number {
  let count = 0;
  for (const obj of result as RenderedObject[]) {
    for (const shape of obj.sceneShapes ?? []) {
      count += (shape.meshes ?? []).length;
    }
  }
  return count;
}

// The evaluator plays the role of an in-browser compiled model module: its
// body is what a .fluid.js top-level would do, using the same lib instance.
const modelEvaluator = async () => {
  const width = param("Width", 100) as number;
  sketch("xy", () => {
    // Legacy rect(width, 50).radius(10).centered(): rounded rectangle centered
    // on the origin, corner radius 10 — four lines + four corner arcs.
    const W = width / 2;
    const H = 25;
    const r = 10;
    const b = line([-W + r, -H], [W - r, -H]);
    const br = arc([W - r, -H], [W, -H + r], [W - r, -H + r]);
    const rt = line([W, -H + r], [W, H - r]);
    const tr = arc([W, H - r], [W - r, H], [W - r, H - r]);
    const t = line([W - r, H], [-W + r, H]);
    const tl = arc([-W + r, H], [-W, H - r], [-W + r, H - r]);
    const l = line([-W, H - r], [-W, -H + r]);
    const bl = arc([-W, -H + r], [-W + r, -H], [-W + r, -H + r]);
    coincident(b.end(), br.start());
    coincident(br.end(), rt.start());
    coincident(rt.end(), tr.start());
    coincident(tr.end(), t.start());
    coincident(t.end(), tl.start());
    coincident(tl.end(), l.start());
    coincident(l.end(), bl.start());
    coincident(bl.end(), b.start());
  });
  const e = extrude(30);
  fillet(4, e.startEdges());
  return {};
};

describe("BrowserEngineHost", () => {
  const host = new BrowserEngineHost();

  it("initializes and reports the protocol handshake", async () => {
    const info = await host.init();
    expect(info.protocolVersion).toBe(VIEWER_PROTOCOL_VERSION);
    expect(info.engineVersion).toBe("dev");
  });

  it("renders a model with params and no object errors", async () => {
    host.setWorkspace({ "model.fluid.js": "unused-by-this-evaluator" }, "model.fluid.js");
    host.setModuleEvaluator(modelEvaluator);
    const outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(outcome.objectErrors).toEqual([]);
    expect(outcome.result.length).toBeGreaterThan(0);
    expect(outcome.rollbackStop).toBe(outcome.result.length - 1);
    expect(totalMeshes(outcome.result)).toBeGreaterThan(0);
    expect(maxAbsX(outcome.result)).toBeCloseTo(50, 1);
    const width = outcome.params?.find((p) => p.label === "Width");
    expect(width?.currentValue).toBe(100);
    expect(width?.controlType).toBe("number");
  });

  it("applies a param override through the value flow", async () => {
    const outcome = await host.setParam("Width", 160);
    expect(outcome.compileError).toBeNull();
    expect(maxAbsX(outcome.result)).toBeCloseTo(80, 1);
    expect(outcome.params?.find((p) => p.label === "Width")?.currentValue).toBe(160);
  });

  it("marks unchanged objects as cached via scene compare", async () => {
    const outcome = await host.render();
    const cached = (outcome.result as RenderedObject[]).filter((o) => o.fromCache);
    expect(cached.length).toBeGreaterThan(0);
  });

  it("resets params back to authored defaults", async () => {
    const outcome = await host.resetParams();
    expect(maxAbsX(outcome.result)).toBeCloseTo(50, 1);
    expect(outcome.params?.find((p) => p.label === "Width")?.currentValue).toBe(100);
  });

  it("rolls back without re-running the module", () => {
    const outcome = host.rollback(2);
    expect(outcome).not.toBeNull();
    expect(outcome!.rollbackStop).toBe(2);
    expect(outcome!.compileError).toBeNull();
  });

  it("serves the previous scene on an eval error and recovers after", async () => {
    await host.render();
    host.setModuleEvaluator(async () => {
      throw new Error("boom at model top-level");
    });
    const failed = await host.render();
    expect(failed.compileError?.message).toContain("boom");
    expect(failed.result.length).toBeGreaterThan(0);
    expect(failed.params).toBeUndefined();

    host.setModuleEvaluator(modelEvaluator);
    const recovered = await host.render();
    expect(recovered.compileError).toBeNull();
    expect(recovered.objectErrors).toEqual([]);
  });

  it("recomputes with a dropped compare baseline (nothing cached)", async () => {
    const outcome = await host.recompute();
    expect(outcome.compileError).toBeNull();
    const cached = (outcome.result as RenderedObject[]).filter((o) => o.fromCache);
    expect(cached.length).toBe(0);
    host.dispose();
  });

  it("generates shim modules that re-export live namespaces", () => {
    const source = engineShimModuleSource("fluidcad/core");
    expect(source).toContain('export const sketch = globalThis.__fluidcad["fluidcad/core"]["sketch"];');
    expect(source).toContain('export const param = globalThis.__fluidcad["fluidcad/core"]["param"];');
    expect(() => engineShimModuleSource("fluidcad/nope")).toThrow(/Unknown fluidcad subpath/);
  });
});
