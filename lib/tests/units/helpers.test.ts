// The inline helpers convert into the unit of the CALLING file. The snippets
// run with a .fluid.js sourceURL so captureSourceLocation resolves a real
// file, the same trick builder-source-location.test.ts uses.

import { describe, it, expect, afterEach } from "vitest";
import * as units from "../../units/index.js";
import { createUnitRegistry, getUnitRegistry } from "../../units/registry.js";

const FILE = "/ws/helpers.fluid.js";

function runFluid(code: string): unknown {
  const names = Object.keys(units);
  const values = names.map((n) => (units as Record<string, unknown>)[n]);
  const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=${FILE}`);
  return fn(...values);
}

describe("fluidcad/units inline helpers", () => {
  afterEach(() => {
    createUnitRegistry({ projectUnit: "mm", rootFile: "" });
  });

  it("convert into millimetres for a file without unit()", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: FILE });
    expect(runFluid("return [mm(3), cm(2), m(1), inch(1), ft(1)];")).toEqual([3, 20, 1000, 25.4, 304.8]);
  });

  it("convert into the calling file's declared unit", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: FILE });
    getUnitRegistry().declare(FILE, "in");
    const [a, b, c] = runFluid("return [inch(1), mm(25.4), ft(1)];") as number[];
    expect(a).toBe(1);
    expect(b).toBeCloseTo(1, 12);
    expect(c).toBeCloseTo(12, 12);
  });

  it("follow the project unit when the file has no unit() of its own", () => {
    createUnitRegistry({ projectUnit: "cm", rootFile: "/ws/other.fluid.js" });
    expect(runFluid("return mm(5);")).toBeCloseTo(0.5, 12);
  });

  it("throw outside a model file", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: FILE });
    expect(() => units.inch(1)).toThrow(/inch\(\): could not determine the calling file/);
  });

  it("reject non-numeric arguments", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: FILE });
    expect(() => runFluid("return mm('3');")).toThrow(/mm\(\): expected a finite number/);
  });
});
