// BrowserRenderResult.unit on every result path — success, compile error,
// rollback — and the fluidcad/units namespace the in-browser bundler links.

import { describe, it, expect } from "vitest";
import { BrowserEngineHost, ENGINE_NAMESPACE_SPECIFIERS, engineShimModuleSource } from "../../browser/index.js";
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
