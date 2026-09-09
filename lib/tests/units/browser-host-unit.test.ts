// BrowserRenderResult.unit on every result path — success, compile error,
// rollback — and the fluidcad/units namespace the in-browser bundler links.

import { describe, it, expect } from "vitest";
import { BrowserEngineHost, ENGINE_NAMESPACE_SPECIFIERS, engineShimModuleSource } from "../../browser/index.js";
import { resolveWorkspaceUnit } from "../../browser/host.js";
import { unit, sketch, extrude } from "../../core/index.js";
import { testRect } from "../helpers/profiles.js";

describe("BrowserEngineHost unit field", () => {
  const host = new BrowserEngineHost();

  it("exposes fluidcad/units to model code", () => {
    expect(ENGINE_NAMESPACE_SPECIFIERS).toContain("fluidcad/units");
    const shim = engineShimModuleSource("fluidcad/units");
    expect(shim).toContain("export const inch =");
    expect(shim).toContain("export const parseLengthUnit =");
  });

  it("reports mm for a model without unit()", async () => {
    await host.init();
    host.setWorkspace({ "model.fluid.js": "" }, "model.fluid.js");
    host.setModuleEvaluator(async () => {
      sketch("xy", () => { testRect(10, 10); });
      extrude(5);
      return {};
    });
    const outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(outcome.unit).toBe("mm");
    // No unit() ran: the document follows the project unit the host booted with.
    expect(outcome.declaredUnit).toBeNull();
    expect(outcome.projectUnit).toBe("mm");
    expect((outcome.result[0] as { unit?: string }).unit).toBe("mm");

    const rolled = host.rollback(0);
    expect(rolled?.unit).toBe("mm");
    expect(rolled?.declaredUnit).toBeNull();
    expect(rolled?.projectUnit).toBe("mm");
  });

  it("follows the workspace's fluidcad.json when it names a unit", async () => {
    host.setWorkspace({ "model.fluid.js": "", "fluidcad.json": '{ "unit": "in" }' }, "model.fluid.js");
    host.setModuleEvaluator(async () => {
      sketch("xy", () => { testRect(1, 1); });
      extrude(0.5);
      return {};
    });
    const outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(outcome.projectUnit).toBe("in");
    expect(outcome.declaredUnit).toBeNull();
    expect(outcome.unit).toBe("in");
    expect((outcome.result[0] as { unit?: string }).unit).toBe("in");

    // The next workspace without a descriptor goes back to the boot unit.
    host.setWorkspace({ "model.fluid.js": "" }, "model.fluid.js");
    expect((await host.render()).projectUnit).toBe("mm");
  });

  it("resolves the project unit: explicit option, then fluidcad.json, then the boot unit", () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    expect(resolveWorkspaceUnit("cm", enc('{ "unit": "in" }'), "mm")).toBe("cm");
    expect(resolveWorkspaceUnit("inches", undefined, "mm")).toBe("in");
    expect(resolveWorkspaceUnit(undefined, enc('{ "unit": "ft", "engine": "0.0.42" }'), "mm")).toBe("ft");
    expect(resolveWorkspaceUnit(null, enc('{ "engine": "0.0.42" }'), "cm")).toBe("cm");
    expect(resolveWorkspaceUnit(undefined, enc('{ "unit": "furlong" }'), "mm")).toBe("mm");
    expect(resolveWorkspaceUnit(undefined, enc("not json"), "mm")).toBe("mm");
    expect(resolveWorkspaceUnit("furlong", undefined, "mm")).toBe("mm");
    expect(resolveWorkspaceUnit(undefined, undefined, "m")).toBe("m");
  });

  it("carries the unit on the compile-error path", async () => {
    host.setModuleEvaluator(async () => {
      // Outside a model file unit() cannot find its caller — the error is
      // surfaced as a compile error, and the result still names a unit.
      unit("in");
      return {};
    });
    const failed = await host.render();
    expect(failed.compileError?.message).toMatch(/unit\(\)/);
    expect(failed.unit).toBe("mm");
    expect(failed.declaredUnit).toBeNull();
    expect(failed.projectUnit).toBe("mm");
  });
});
