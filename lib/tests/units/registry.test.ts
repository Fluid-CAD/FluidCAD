import { describe, it, expect, afterEach } from "vitest";
import {
  UnitRegistry, createUnitRegistry, getUnitRegistry, setUnitRegistry, getActiveUnit, withUnit,
} from "../../units/registry.js";
import { mmTol, mmTol2, mmTol3 } from "../../units/tolerance.js";

const ROOT = "/ws/model.fluid.js";
const OTHER = "/ws/lib.part.js";

describe("UnitRegistry", () => {
  afterEach(() => {
    // Leave the lazily created default behind for the next suite.
    createUnitRegistry({ projectUnit: "mm", rootFile: "" });
  });

  it("resolves a file's unit() first, then the nearest project config, then the project unit", () => {
    const registry = new UnitRegistry({
      projectUnit: "cm",
      rootFile: ROOT,
      projectUnitForFile: (file) => (file === OTHER ? "ft" : null),
    });
    expect(registry.resolve(ROOT)).toBe("cm");
    expect(registry.resolve(OTHER)).toBe("ft");
    expect(registry.resolve(null)).toBe("cm");
    expect(registry.resolve(undefined)).toBe("cm");

    registry.declare(OTHER, "in");
    expect(registry.resolve(OTHER)).toBe("in");
    expect(registry.declared(OTHER)).toBe("in");
    expect(registry.declared(ROOT)).toBeNull();
    expect(registry.rootUnit).toBe("cm");

    registry.declare(ROOT, "m");
    expect(registry.rootUnit).toBe("m");
  });

  it("rejects a second unit() for the same file", () => {
    const registry = new UnitRegistry({ projectUnit: "mm", rootFile: ROOT });
    registry.declare(ROOT, "in");
    expect(() => registry.declare(ROOT, "in")).toThrow(`unit(): unit() was already called in ${ROOT}`);
    // Other files are unaffected.
    expect(() => registry.declare(OTHER, "cm")).not.toThrow();
  });

  it("rejects unit() once geometry has started for the file", () => {
    const registry = new UnitRegistry({ projectUnit: "mm", rootFile: ROOT });
    registry.markGeometry(ROOT);
    expect(registry.hasGeometry(ROOT)).toBe(true);
    expect(registry.hasGeometry(OTHER)).toBe(false);
    expect(() => registry.declare(ROOT, "in")).toThrow(`unit(): unit() must come before any geometry in ${ROOT}`);
    // A statement with no captured file marks nothing.
    registry.markGeometry(null);
    registry.markGeometry(undefined);
    expect(() => registry.declare(OTHER, "in")).not.toThrow();
  });

  it("createUnitRegistry installs the current registry; setUnitRegistry swaps it back", () => {
    const a = createUnitRegistry({ projectUnit: "in", rootFile: ROOT });
    expect(getUnitRegistry()).toBe(a);
    const b = createUnitRegistry({ projectUnit: "cm", rootFile: ROOT });
    expect(getUnitRegistry()).toBe(b);
    setUnitRegistry(a);
    expect(getUnitRegistry()).toBe(a);
    expect(getActiveUnit()).toBe("in");
  });
});

describe("withUnit / getActiveUnit", () => {
  afterEach(() => {
    createUnitRegistry({ projectUnit: "mm", rootFile: "" });
  });

  it("falls back to the root document's unit outside any scope", () => {
    createUnitRegistry({ projectUnit: "cm", rootFile: ROOT });
    expect(getActiveUnit()).toBe("cm");
    getUnitRegistry().declare(ROOT, "in");
    expect(getActiveUnit()).toBe("in");
  });

  it("nests and returns the callback's value", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: ROOT });
    const seen: string[] = [];
    const result = withUnit("in", () => {
      seen.push(getActiveUnit());
      withUnit("ft", () => {
        seen.push(getActiveUnit());
      });
      seen.push(getActiveUnit());
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual(["in", "ft", "in"]);
    expect(getActiveUnit()).toBe("mm");
  });

  it("pops the scope when the callback throws", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: ROOT });
    expect(() => withUnit("in", () => { throw new Error("boom"); })).toThrow("boom");
    expect(getActiveUnit()).toBe("mm");
  });
});

describe("mmTol family", () => {
  afterEach(() => {
    createUnitRegistry({ projectUnit: "mm", rootFile: "" });
  });

  it("is the identity in millimetres", () => {
    createUnitRegistry({ projectUnit: "mm", rootFile: ROOT });
    expect(mmTol(0.01)).toBe(0.01);
    expect(mmTol2(0.01)).toBe(0.01);
    expect(mmTol3(0.01)).toBe(0.01);
  });

  it("expresses mm tolerances in the active unit, squared and cubed for areas and volumes", () => {
    withUnit("in", () => {
      expect(mmTol(25.4)).toBeCloseTo(1, 12);
      expect(mmTol2(25.4 * 25.4)).toBeCloseTo(1, 12);
      expect(mmTol3(25.4 ** 3)).toBeCloseTo(1, 12);
    });
    withUnit("cm", () => {
      expect(mmTol(1)).toBeCloseTo(0.1, 12);
      expect(mmTol2(1)).toBeCloseTo(0.01, 12);
      expect(mmTol3(1)).toBeCloseTo(0.001, 12);
    });
  });
});
