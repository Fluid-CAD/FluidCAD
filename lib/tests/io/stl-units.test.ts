import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { FileExport } from "../../io/file-export.js";
import { box, stlBounds } from "./helpers.js";

describe("STL export units", () => {
  setupOC();

  it("scales an inch compound into mm by default", () => {
    const solids = box(1);
    const data = FileExport.exportShapes(solids, { format: "stl", unit: "in" }).data as Uint8Array;
    const bounds = stlBounds(data);
    expect(bounds.max.map(v => +v.toFixed(4))).toEqual([25.4, 25.4, 25.4]);
    expect(bounds.min.map(v => +Math.abs(v).toFixed(4))).toEqual([0, 0, 0]);
  });

  it("keeps document units when asked", () => {
    const solids = box(1);
    const data = FileExport.exportShapes(solids, { format: "stl", unit: "in", scaleTo: "document" }).data as Uint8Array;
    expect(stlBounds(data).max.map(v => +v.toFixed(4))).toEqual([1, 1, 1]);
  });

  it("leaves an mm compound alone either way", () => {
    const solids = box(10);
    for (const scaleTo of ["mm", "document"] as const) {
      const data = FileExport.exportShapes(solids, { format: "stl", scaleTo }).data as Uint8Array;
      expect(stlBounds(data).max.map(v => +v.toFixed(4))).toEqual([10, 10, 10]);
    }
  });

  it("converts presets (mm) and custom deflections (document units) into the mesh unit", () => {
    // Preset 0.3 mm on an inch document written in inches: 0.3 / 25.4.
    const presetIn = FileExport.stlDeflections({ resolution: "medium" }, "in", "in");
    expect(presetIn.linearDeflection).toBeCloseTo(0.3 / 25.4, 12);
    // Same preset when the mesh is scaled into mm: stays 0.3.
    const presetMm = FileExport.stlDeflections({ resolution: "medium" }, "in", "mm");
    expect(presetMm.linearDeflection).toBe(0.3);
    // A custom 0.01 in deflection on a mesh written in mm: 0.254.
    const custom = FileExport.stlDeflections(
      { resolution: "custom", customLinearDeflection: 0.01, customAngularDeflectionDeg: 10 },
      "in",
      "mm",
    );
    expect(custom.linearDeflection).toBeCloseTo(0.254, 12);
    expect(custom.angularDeflection).toBeCloseTo((10 * Math.PI) / 180, 12);
    // mm document, mm mesh: untouched.
    const mm = FileExport.stlDeflections(
      { resolution: "custom", customLinearDeflection: 0.2, customAngularDeflectionDeg: 10 },
      "mm",
      "mm",
    );
    expect(mm.linearDeflection).toBe(0.2);
  });
});
