// The browser host renders a generated definition (a definePart /
// defineAssembly export of the entry) with values a host gives it
// (setGeneratedValues, HG-S1): the variant of those values, at a detail
// tier, and the outcome's `generated` reports what each generated export
// was rendered with — the values completed by the schema. A refused value is
// the export's objectErrors row (render() never throws — every test asserts
// objectErrors / compileError); resetParams() and unloadModel() forget the
// values; a preview-tier render reaches ctx.detail, the full one after it
// builds once more, and a second full render is served from the template
// cache. Build counts come from the fixtures (defineSpur({ builds }),
// defineCabinet().details).

import { describe, it, expect } from "vitest";
import { BrowserEngineHost, VIEWER_PROTOCOL_VERSION, type BrowserRenderResult } from "../browser/index.js";
import { definePart, defineAssembly } from "../sdk/index.js";
import part from "../core/part.js";
import { param } from "../core/index.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { testRect } from "./helpers/profiles.js";
import { defineSpur, spurRadius, SPUR_DEFAULTS, type SpurClass } from "./fixtures/custom-features/spur.js";
import { defineCabinet, CABINET_DEFAULTS, type CabinetClass } from "./fixtures/custom-features/cabinet.js";

/** Where the entry modules' `definePart()` / `defineAssembly()` calls are located (a `//# sourceURL`): the entry files themselves. */
const SPUR_FILE = "/parts/spur.part.js";
const CABINET_FILE = "/assemblies/cabinet.assembly.js";

interface RenderedMesh { vertices: number[] }
interface RenderedShape { meshes: RenderedMesh[] }
interface RenderedObject { type?: string; name?: string; uniqueType?: string; hasError?: boolean; errorMessage?: string; sceneShapes?: RenderedShape[] }

function rows(outcome: BrowserRenderResult): RenderedObject[] {
  return outcome.result as RenderedObject[];
}

/** The rendered rows of `type`, in scene order. */
function rowsOf(outcome: BrowserRenderResult, type: string): RenderedObject[] {
  return rows(outcome).filter(row => row.type === type);
}

/** The largest |x| any rendered vertex reaches: a disc's radius, for a spur standing at the origin. */
function maxAbsX(outcome: BrowserRenderResult): number {
  let max = 0;
  for (const obj of rows(outcome)) {
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

/**
 * The spur part's module as the entry evaluates it on every render: a new
 * definition of the same class, located in {@link SPUR_FILE} and exported,
 * as `export const spurPart = definePart(Spur, { … })` is.
 */
function spurModule(Spur: SpurClass): Record<string, unknown> {
  return new Function("definePart", "Spur", `return { spurPart: definePart(Spur, { label: 'Spur gear' }) };\n//# sourceURL=${SPUR_FILE}`)(
    definePart, Spur,
  ) as Record<string, unknown>;
}

/** The cabinet's module as the entry evaluates it: `export const cabinet = defineAssembly(Cabinet, { … })`, located in {@link CABINET_FILE}. */
function cabinetModule(Cabinet: CabinetClass): Record<string, unknown> {
  return new Function("defineAssembly", "Cabinet", `return { cabinet: defineAssembly(Cabinet, { label: 'Cabinet' }) };\n//# sourceURL=${CABINET_FILE}`)(
    defineAssembly, Cabinet,
  ) as Record<string, unknown>;
}

const SPUR_SCHEMA_DEFAULTS = { teeth: SPUR_DEFAULTS.teeth, module: SPUR_DEFAULTS.module, width: SPUR_DEFAULTS.width, style: SPUR_DEFAULTS.style };

describe("BrowserEngineHost generated values", () => {
  const host = new BrowserEngineHost();

  it("speaks protocol 3", async () => {
    const info = await host.init();
    expect(info.protocolVersion).toBe(3);
    expect(VIEWER_PROTOCOL_VERSION).toBe(3);
  });

  describe("a definePart entry", () => {
    const builds: number[] = [];
    const { Spur } = defineSpur({ builds });

    it("renders its defaults, reported as the export's completed values", async () => {
      host.unloadModel();
      host.setWorkspace({ "parts/spur.part.js": "unused" }, "parts/spur.part.js");
      host.setModuleEvaluator(async () => spurModule(Spur));
      const outcome = await host.render();
      expect(outcome.compileError).toBeNull();
      expect(outcome.objectErrors).toEqual([]);
      expect(outcome.sceneKind).toBe("part");
      expect(rowsOf(outcome, "part")).toHaveLength(1);
      expect(maxAbsX(outcome)).toBeCloseTo(spurRadius(SPUR_DEFAULTS.teeth, SPUR_DEFAULTS.module), 1);
      expect(outcome.generated).toEqual([
        { exportName: "spurPart", id: "acme.spur", kind: "part", label: "Spur gear", values: SPUR_SCHEMA_DEFAULTS },
      ]);
      expect(builds).toEqual([SPUR_DEFAULTS.teeth]);
    });

    it("renders the variant of the values set for the export: one part, its connector from the frame, the values completed", async () => {
      const outcome = await host.setGeneratedValues("spurPart", { teeth: 18, width: 12 });
      expect(outcome.compileError).toBeNull();
      expect(outcome.objectErrors).toEqual([]);
      // Exactly one part: the variant stands in for the defaults, which the
      // leftover pass does not build beside it.
      expect(rowsOf(outcome, "part")).toHaveLength(1);
      expect(maxAbsX(outcome)).toBeCloseTo(spurRadius(18, SPUR_DEFAULTS.module), 1);
      const connectors = rowsOf(outcome, "connector");
      expect(connectors.map(row => row.name)).toEqual(["axis"]);
      expect(outcome.generated).toEqual([
        { exportName: "spurPart", id: "acme.spur", kind: "part", label: "Spur gear", values: { ...SPUR_SCHEMA_DEFAULTS, teeth: 18, width: 12 } },
      ]);
      expect(builds).toEqual([SPUR_DEFAULTS.teeth, 18]);
    });

    it("keeps the values through a plain render, served by the compare", async () => {
      const outcome = await host.render();
      expect(outcome.objectErrors).toEqual([]);
      expect(maxAbsX(outcome)).toBeCloseTo(spurRadius(18, SPUR_DEFAULTS.module), 1);
      expect(outcome.generated?.[0].values).toEqual({ ...SPUR_SCHEMA_DEFAULTS, teeth: 18, width: 12 });
      expect(builds).toEqual([SPUR_DEFAULTS.teeth, 18]);
    });

    it("reports a refused value as the export's objectErrors row, the values as given", async () => {
      const outOfRange = await host.setGeneratedValues("spurPart", { teeth: 2 });
      expect(outOfRange.compileError).toBeNull();
      expect(outOfRange.objectErrors).toHaveLength(1);
      expect(outOfRange.objectErrors[0].message).toContain("teeth");
      expect(outOfRange.objectErrors[0].uniqueKind).toBe("part");
      expect(rowsOf(outOfRange, "part")).toHaveLength(1);
      expect(outOfRange.generated).toEqual([
        { exportName: "spurPart", id: "acme.spur", kind: "part", label: "Spur gear", values: { teeth: 2 } },
      ]);

      const unknown = await host.setGeneratedValues("spurPart", { teef: 18 });
      expect(unknown.objectErrors).toHaveLength(1);
      expect(unknown.objectErrors[0].message).toContain("teef");
      expect(unknown.generated?.[0].values).toEqual({ teef: 18 });
      // Nothing was built for either: no value reached the feature.
      expect(builds).toEqual([SPUR_DEFAULTS.teeth, 18]);
    });

    it("renders the defaults again after resetParams()", async () => {
      const outcome = await host.resetParams();
      expect(outcome.objectErrors).toEqual([]);
      expect(rowsOf(outcome, "part")).toHaveLength(1);
      expect(maxAbsX(outcome)).toBeCloseTo(spurRadius(SPUR_DEFAULTS.teeth, SPUR_DEFAULTS.module), 1);
      expect(outcome.generated?.[0].values).toEqual(SPUR_SCHEMA_DEFAULTS);
    });

    it("keeps a part() beside the definePart: params stay, one generated entry", async () => {
      host.unloadModel();
      host.setWorkspace({ "parts/spur.part.js": "unused" }, "parts/spur.part.js");
      host.setModuleEvaluator(async () => new Function(
        "definePart", "Spur", "part", "param", "sketch", "extrude", "testRect",
        `return {
          plate: part('Plate', () => {
            const width = param('Width', 100);
            sketch('xy', () => { testRect(width, 50); });
            extrude(10);
          }),
          spurPart: definePart(Spur, { label: 'Spur gear' }),
        };\n//# sourceURL=${SPUR_FILE}`,
      )(definePart, Spur, part, param, sketch, extrude, testRect) as Record<string, unknown>);
      const outcome = await host.setGeneratedValues("spurPart", { teeth: 30 });
      expect(outcome.compileError).toBeNull();
      expect(outcome.objectErrors).toEqual([]);
      expect(rowsOf(outcome, "part").map(row => row.name)).toEqual(["Plate", "Spur gear"]);
      expect(outcome.params?.find(p => p.label === "Width")?.currentValue).toBe(100);
      expect(outcome.generated).toEqual([
        { exportName: "spurPart", id: "acme.spur", kind: "part", label: "Spur gear", values: { ...SPUR_SCHEMA_DEFAULTS, teeth: 30 } },
      ]);
      // The param override and the generated values stand side by side.
      const widened = await host.setParam("Width", 160);
      expect(widened.objectErrors).toEqual([]);
      expect(widened.params?.find(p => p.label === "Width")?.currentValue).toBe(160);
      expect(widened.generated?.[0].values.teeth).toBe(30);
    });

    it("forgets the values on unloadModel()", async () => {
      host.unloadModel();
      host.setWorkspace({ "parts/spur.part.js": "unused" }, "parts/spur.part.js");
      host.setModuleEvaluator(async () => spurModule(Spur));
      const outcome = await host.render();
      expect(outcome.objectErrors).toEqual([]);
      expect(outcome.generated?.[0].values).toEqual(SPUR_SCHEMA_DEFAULTS);
      expect(maxAbsX(outcome)).toBeCloseTo(spurRadius(SPUR_DEFAULTS.teeth, SPUR_DEFAULTS.module), 1);
    });

    it("reports no generated export for a plain part entry", async () => {
      host.unloadModel();
      host.setWorkspace({ "model.fluid.js": "unused" }, "model.fluid.js");
      host.setModuleEvaluator(async () => {
        part("Plate", () => {
          sketch("xy", () => { testRect(20, 10); });
          extrude(5);
        });
        return {};
      });
      const outcome = await host.render();
      expect(outcome.objectErrors).toEqual([]);
      expect(outcome.generated).toEqual([]);
    });
  });

  describe("a defineAssembly entry", () => {
    const { Cabinet, details } = defineCabinet();
    const instanceNames = (outcome: BrowserRenderResult) => outcome.assembly?.instances.map(i => i.name);
    const CABINET_SCHEMA_DEFAULTS = { ...CABINET_DEFAULTS };

    it("renders its defaults at the root, reported as the export's completed values", async () => {
      host.unloadModel();
      host.setWorkspace({ "assemblies/cabinet.assembly.js": "unused" }, "assemblies/cabinet.assembly.js");
      host.setModuleEvaluator(async () => cabinetModule(Cabinet));
      const outcome = await host.render();
      expect(outcome.compileError).toBeNull();
      expect(outcome.objectErrors).toEqual([]);
      expect(outcome.sceneKind).toBe("assembly");
      expect(instanceNames(outcome)).toEqual(["Carcass", "Left door", "Right door", "Drawer 1", "Drawer 2"]);
      expect(outcome.assembly?.mates).toHaveLength(4);
      expect(outcome.generated).toEqual([
        { exportName: "cabinet", id: "acme.cabinet", kind: "assembly", label: "Cabinet", values: CABINET_SCHEMA_DEFAULTS },
      ]);
      expect(details.every(entry => entry.endsWith(":full"))).toBe(true);
      expect(details).toHaveLength(3);
    });

    it("renders the layout of the values set for the export, at the preview tier when asked", async () => {
      details.length = 0;
      const outcome = await host.setGeneratedValues("cabinet", { drawers: 3, width: 900 }, { detail: "preview" });
      expect(outcome.compileError).toBeNull();
      expect(outcome.objectErrors).toEqual([]);
      expect(instanceNames(outcome)).toEqual(["Carcass", "Left door", "Right door", "Drawer 1", "Drawer 2", "Drawer 3"]);
      expect(outcome.assembly?.mates).toHaveLength(5);
      expect(outcome.generated).toEqual([
        { exportName: "cabinet", id: "acme.cabinet", kind: "assembly", label: "Cabinet", values: { ...CABINET_SCHEMA_DEFAULTS, drawers: 3, width: 900 } },
      ]);
      // Every template built this pass was built at the preview tier.
      expect(details).toEqual(["carcass:preview", "door:preview", "drawer:preview"]);
    });

    it("builds the same values once more at the full tier, then serves them from the template cache", async () => {
      details.length = 0;
      const full = await host.setGeneratedValues("cabinet", { drawers: 3, width: 900 });
      expect(full.objectErrors).toEqual([]);
      expect(instanceNames(full)).toHaveLength(6);
      expect(details).toEqual(["carcass:full", "door:full", "drawer:full"]);

      details.length = 0;
      const again = await host.render();
      expect(again.objectErrors).toEqual([]);
      expect(instanceNames(again)).toHaveLength(6);
      expect(again.generated?.[0].values).toEqual({ ...CABINET_SCHEMA_DEFAULTS, drawers: 3, width: 900 });
      expect(details).toEqual([]);

      // recompute() rebuilds from scratch, the generated values kept.
      const rebuilt = await host.recompute();
      expect(rebuilt.objectErrors).toEqual([]);
      expect(instanceNames(rebuilt)).toHaveLength(6);
      expect(details).toEqual(["carcass:full", "door:full", "drawer:full"]);
    });

    it("reports a refused value as the export's objectErrors row and renders the defaults after resetParams()", async () => {
      const refused = await host.setGeneratedValues("cabinet", { drawers: 9 });
      expect(refused.compileError).toBeNull();
      expect(refused.objectErrors).toHaveLength(1);
      expect(refused.objectErrors[0].message).toContain("drawers");
      expect(refused.generated).toEqual([
        { exportName: "cabinet", id: "acme.cabinet", kind: "assembly", label: "Cabinet", values: { drawers: 9 } },
      ]);

      const reset = await host.resetParams();
      expect(reset.objectErrors).toEqual([]);
      expect(instanceNames(reset)).toEqual(["Carcass", "Left door", "Right door", "Drawer 1", "Drawer 2"]);
      expect(reset.generated?.[0].values).toEqual(CABINET_SCHEMA_DEFAULTS);
    });

    it("drops the generated values with the model on unloadModel()", async () => {
      await host.setGeneratedValues("cabinet", { drawers: 0 });
      host.unloadModel();
      host.setWorkspace({ "assemblies/cabinet.assembly.js": "unused" }, "assemblies/cabinet.assembly.js");
      host.setModuleEvaluator(async () => cabinetModule(Cabinet));
      const outcome = await host.render();
      expect(outcome.objectErrors).toEqual([]);
      expect(instanceNames(outcome)).toHaveLength(5);
      expect(outcome.generated?.[0].values).toEqual(CABINET_SCHEMA_DEFAULTS);
    });

    it("renders a load's values in the load's own pass (render({ generated, detail })), kept for the passes after", async () => {
      host.unloadModel();
      host.setWorkspace({ "assemblies/cabinet.assembly.js": "unused" }, "assemblies/cabinet.assembly.js");
      host.setModuleEvaluator(async () => cabinetModule(Cabinet));
      details.length = 0;
      const loaded = await host.render({ generated: { cabinet: { drawers: 1 } }, detail: "preview" });
      expect(loaded.compileError).toBeNull();
      expect(loaded.objectErrors).toEqual([]);
      expect(instanceNames(loaded)).toEqual(["Carcass", "Left door", "Right door", "Drawer 1"]);
      expect(loaded.generated?.[0].values).toEqual({ ...CABINET_SCHEMA_DEFAULTS, drawers: 1 });
      expect(details).toEqual(["carcass:preview", "door:preview", "drawer:preview"]);

      const settled = await host.render();
      expect(settled.objectErrors).toEqual([]);
      expect(instanceNames(settled)).toHaveLength(4);
      expect(settled.generated?.[0].values.drawers).toBe(1);
      host.dispose();
    });
  });

  it("refuses a misuse before rendering", async () => {
    await expect(host.setGeneratedValues("", { teeth: 18 })).rejects.toThrow(/export name/);
    await expect(host.setGeneratedValues("spurPart", [18] as unknown as Record<string, unknown>)).rejects.toThrow(/values by id/);
    await expect(host.render({ generated: { cabinet: null as unknown as Record<string, unknown> } })).rejects.toThrow(/values by id/);
  });
});
