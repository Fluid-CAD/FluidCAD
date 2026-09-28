import { describe, it, expect } from "vitest";
import {
  MATERIALS,
  DENSITY_UNITS,
  densityFromGcm3,
  densityToGcm3,
  getMaterials,
  isDensityUnit,
  materialDensityGcm3,
  mergeMaterials,
  resolveMaterial,
} from "../common/materials.js";
import type { ProjectMaterials } from "../common/materials.js";

const PROJECT: ProjectMaterials = {
  "alloy-steel": { name: "Alloy Steel", density: 7.7, densityUnit: "g/cm³" },
  "acme-pla": { name: "ACME PLA+", density: 1.27 },
};

describe("built-in materials", () => {
  it("every built-in carries a fluidcad- id, in table order, flagged builtin", () => {
    expect(MATERIALS.map(m => m.id)).toEqual([
      "fluidcad-steel-1020",
      "fluidcad-stainless-304",
      "fluidcad-aluminum-6061",
      "fluidcad-aluminum-1060",
      "fluidcad-aluminum-7075",
      "fluidcad-brass-c260",
      "fluidcad-copper",
      "fluidcad-titanium-6al4v",
      "fluidcad-cast-iron-gray",
      "fluidcad-bronze",
      "fluidcad-pc",
      "fluidcad-abs",
      "fluidcad-pla",
      "fluidcad-nylon-pa6",
      "fluidcad-carbon-fiber",
      "fluidcad-pine",
      "fluidcad-carbon-steel",
    ]);
    expect(MATERIALS.every(m => m.source === "builtin")).toBe(true);
    expect(MATERIALS.every(m => isDensityUnit(m.densityUnit))).toBe(true);
    expect(new Set(MATERIALS.map(m => m.id)).size).toBe(MATERIALS.length);
  });

  it("getMaterials() without a project map is the built-in list", () => {
    expect(getMaterials()).toEqual([...MATERIALS]);
    expect(getMaterials(null)).toEqual([...MATERIALS]);
  });
});

describe("mergeMaterials", () => {
  it("keeps every built-in and appends project entries flagged project", () => {
    const merged = mergeMaterials(PROJECT);
    expect(merged).toHaveLength(MATERIALS.length + 2);
    expect(merged.slice(0, MATERIALS.length)).toEqual([...MATERIALS]);
    expect(merged.slice(MATERIALS.length)).toEqual([
      { id: "alloy-steel", name: "Alloy Steel", density: 7.7, densityUnit: "g/cm³", source: "project" },
      { id: "acme-pla", name: "ACME PLA+", density: 1.27, densityUnit: "g/cm³", source: "project" },
    ]);
  });

  it("a project entry reusing a built-in id replaces it in place", () => {
    const merged = mergeMaterials({ "fluidcad-pla": { name: "House PLA", density: 1.3 } });
    expect(merged).toHaveLength(MATERIALS.length);
    const index = merged.findIndex(m => m.id === "fluidcad-pla");
    expect(index).toBe(MATERIALS.findIndex(m => m.id === "fluidcad-pla"));
    expect(merged[index]).toEqual({ id: "fluidcad-pla", name: "House PLA", density: 1.3, densityUnit: "g/cm³", source: "project" });
  });

  it("getMaterials(project) is the merged list", () => {
    expect(getMaterials(PROJECT)).toEqual(mergeMaterials(PROJECT));
  });
});

describe("resolveMaterial", () => {
  it("returns undefined for an unknown id", () => {
    expect(resolveMaterial("steel")).toBeUndefined();
    expect(resolveMaterial("steel", PROJECT)).toBeUndefined();
    expect(resolveMaterial("", PROJECT)).toBeUndefined();
  });

  it("resolves a built-in with or without a project map", () => {
    const steel = resolveMaterial("fluidcad-steel-1020");
    expect(steel).toEqual({ id: "fluidcad-steel-1020", name: "Steel (AISI 1020)", density: 7.87, densityUnit: "g/cm³", source: "builtin" });
    expect(resolveMaterial("fluidcad-steel-1020", PROJECT)).toEqual(steel);
  });

  it("resolves a project material, defaulting densityUnit to g/cm³", () => {
    expect(resolveMaterial("alloy-steel", PROJECT)).toEqual({ id: "alloy-steel", name: "Alloy Steel", density: 7.7, densityUnit: "g/cm³", source: "project" });
    expect(resolveMaterial("acme-pla", PROJECT)).toEqual({ id: "acme-pla", name: "ACME PLA+", density: 1.27, densityUnit: "g/cm³", source: "project" });
  });

  it("a project override wins over the built-in of the same id", () => {
    const resolved = resolveMaterial("fluidcad-pla", { "fluidcad-pla": { name: "House PLA", density: 1.3, densityUnit: "kg/m³" } });
    expect(resolved).toEqual({ id: "fluidcad-pla", name: "House PLA", density: 1.3, densityUnit: "kg/m³", source: "project" });
  });

  it("does not resolve inherited object keys as materials", () => {
    expect(resolveMaterial("toString", PROJECT)).toBeUndefined();
    expect(resolveMaterial("constructor", {})).toBeUndefined();
  });
});

describe("density conversion", () => {
  it("lists the four panel units", () => {
    expect(DENSITY_UNITS).toEqual(["g/cm³", "kg/m³", "g/mm³", "lbs/in³"]);
    expect(isDensityUnit("g/cm³")).toBe(true);
    expect(isDensityUnit("kg/dm³")).toBe(false);
    expect(isDensityUnit(7.8)).toBe(false);
  });

  it("uses the Shape Properties panel factors into g/cm³", () => {
    expect(densityToGcm3(1, "g/cm³")).toBe(1);
    expect(densityToGcm3(1000, "kg/m³")).toBe(1);
    expect(densityToGcm3(0.001, "g/mm³")).toBe(1);
    expect(densityToGcm3(1, "lbs/in³")).toBeCloseTo(27.6799, 4);
  });

  it("round-trips through every unit", () => {
    for (const unit of DENSITY_UNITS) {
      expect(densityFromGcm3(densityToGcm3(7.87, unit), unit)).toBeCloseTo(7.87, 9);
    }
  });

  it("materialDensityGcm3 normalizes the one lbs/in³ built-in", () => {
    const carbonSteel = resolveMaterial("fluidcad-carbon-steel")!;
    expect(carbonSteel.densityUnit).toBe("lbs/in³");
    expect(materialDensityGcm3(carbonSteel)).toBeCloseTo(0.098 * 27.6799, 6);
    expect(materialDensityGcm3(resolveMaterial("fluidcad-copper")!)).toBe(8.96);
  });
});
