import { describe, it, expect } from "vitest";
import {
  LENGTH_UNITS, DEFAULT_LENGTH_UNIT, MM_PER_UNIT, UNIT_DISPLAY_DECIMALS,
  isLengthUnit, parseLengthUnit, convertLength, unitFactor,
} from "../../units/units.js";

describe("units table", () => {
  it("lists the supported units in order with their mm factors", () => {
    expect(LENGTH_UNITS).toEqual(["mm", "cm", "m", "in", "ft"]);
    expect(DEFAULT_LENGTH_UNIT).toBe("mm");
    expect(MM_PER_UNIT).toEqual({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 });
    expect(UNIT_DISPLAY_DECIMALS).toEqual({ mm: 2, cm: 3, m: 4, in: 3, ft: 4 });
  });

  it("isLengthUnit accepts only canonical codes", () => {
    expect(isLengthUnit("mm")).toBe(true);
    expect(isLengthUnit("in")).toBe(true);
    expect(isLengthUnit("inch")).toBe(false);
    expect(isLengthUnit("MM")).toBe(false);
    expect(isLengthUnit(25.4)).toBe(false);
    expect(isLengthUnit(null)).toBe(false);
  });

  it("parseLengthUnit canonicalises aliases case-insensitively", () => {
    expect(parseLengthUnit("mm")).toBe("mm");
    expect(parseLengthUnit(" MM ")).toBe("mm");
    expect(parseLengthUnit("Millimeters")).toBe("mm");
    expect(parseLengthUnit("millimetre")).toBe("mm");
    expect(parseLengthUnit("centimetres")).toBe("cm");
    expect(parseLengthUnit("Meter")).toBe("m");
    expect(parseLengthUnit("metres")).toBe("m");
    expect(parseLengthUnit("inch")).toBe("in");
    expect(parseLengthUnit("Inches")).toBe("in");
    expect(parseLengthUnit('"')).toBe("in");
    expect(parseLengthUnit("foot")).toBe("ft");
    expect(parseLengthUnit("FEET")).toBe("ft");
    expect(parseLengthUnit("'")).toBe("ft");
  });

  it("parseLengthUnit rejects unknown values with the supported list", () => {
    expect(() => parseLengthUnit("furlong")).toThrow("Unknown length unit 'furlong'. Use one of: mm, cm, m, in, ft.");
    expect(() => parseLengthUnit(undefined)).toThrow(/Unknown length unit/);
    expect(() => parseLengthUnit(5)).toThrow(/Unknown length unit/);
  });

  it("converts between units through millimetres", () => {
    expect(unitFactor("in", "mm")).toBe(25.4);
    expect(unitFactor("mm", "in")).toBeCloseTo(1 / 25.4, 12);
    expect(unitFactor("ft", "in")).toBeCloseTo(12, 12);
    expect(convertLength(1, "in", "mm")).toBe(25.4);
    expect(convertLength(254, "mm", "in")).toBeCloseTo(10, 12);
    expect(convertLength(2, "m", "cm")).toBeCloseTo(200, 12);
    expect(convertLength(3.2, "mm", "in")).toBeCloseTo(0.12598, 5);
    // Same-unit conversion is the identity, bit for bit.
    expect(convertLength(0.1, "mm", "mm")).toBe(0.1);
  });
});
