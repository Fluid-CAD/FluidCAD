import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { testRect } from "./helpers/profiles.js";

// `.close()` is a UI-only flag: it marks a trailing sketch finished so the
// editor leaves sketch mode without a consuming feature. The render carries
// it on the sketch row and nowhere else; geometry is untouched.
describe("sketch().close()", () => {
  setupOC();

  it("flags the rendered sketch row as closed", () => {
    sketch("xy", () => { testRect(20, 10); }).close();
    const rows = render().getRenderedObjects();
    const row = rows.find(o => o.type === "sketch");
    expect(row).toBeDefined();
    expect(row!.closed).toBe(true);
    expect(row!.visible).toBe(true);
  });

  it("leaves an open sketch without the flag", () => {
    sketch("xy", () => { testRect(20, 10); });
    const row = render().getRenderedObjects().find(o => o.type === "sketch");
    expect(row!.closed).toBeUndefined();
  });

  it("does not change consumption: a closed sketch still feeds extrude", () => {
    sketch("xy", () => { testRect(20, 10); }).close();
    extrude(5);
    const rows = render().getRenderedObjects();
    const sketchRow = rows.find(o => o.type === "sketch")!;
    expect(sketchRow.closed).toBe(true);
    expect(sketchRow.visible).toBe(false);
    const solid = rows.find(o => o.type === "extrude")!;
    expect(solid.sceneShapes.some(s => s.shapeType === "solid")).toBe(true);
  });
});
