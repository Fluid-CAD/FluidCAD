// The browser host lifts the project's `materials` map out of the
// `fluidcad.json` a share link or package carries, the way it lifts the
// unit, and answers the merged list the desktop's GET /api/materials would.

import { describe, it, expect } from "vitest";
import { BrowserEngineHost, resolveWorkspaceMaterials } from "../browser/host.js";
import { MATERIALS } from "../common/materials.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("resolveWorkspaceMaterials", () => {
  it("reads the map from fluidcad.json and defaults to none", () => {
    const materials = { "alloy-steel": { name: "Alloy Steel", density: 7.7, densityUnit: "g/cm³" } };
    expect(resolveWorkspaceMaterials(undefined, encode({ unit: "in", materials }))).toEqual(materials);
    expect(resolveWorkspaceMaterials(undefined, encode({ unit: "in" }))).toBeNull();
    expect(resolveWorkspaceMaterials(undefined, undefined)).toBeNull();
    expect(resolveWorkspaceMaterials(undefined, new TextEncoder().encode("not json"))).toBeNull();
  });

  it("prefers an explicit map (a package manifest's) over the file", () => {
    const explicit = { pine: { name: "Pine", density: 0.5 } };
    const inFile = { oak: { name: "Oak", density: 0.7 } };
    expect(resolveWorkspaceMaterials(explicit, encode({ materials: inFile }))).toEqual(explicit);
  });

  it("skips entries that are not materials and keeps the rest", () => {
    const raw = {
      good: { name: "Good", density: 1.2 },
      "": { name: "Empty id", density: 1 },
      noName: { density: 1 },
      zero: { name: "Zero", density: 0 },
      text: { name: "Text", density: "heavy" },
      scalar: 4,
    };
    expect(resolveWorkspaceMaterials(undefined, encode({ materials: raw }))).toEqual({ good: { name: "Good", density: 1.2 } });
    expect(resolveWorkspaceMaterials(undefined, encode({ materials: { zero: { name: "Zero", density: 0 } } }))).toBeNull();
    expect(resolveWorkspaceMaterials(undefined, encode({ materials: ["x"] }))).toBeNull();
  });
});

describe("BrowserEngineHost materials", () => {
  it("merges the workspace map over the built-ins and resolves ids through it", () => {
    const host = new BrowserEngineHost();
    host.setWorkspace(
      {
        "model.fluid.js": "",
        "fluidcad.json": JSON.stringify({ materials: { "fluidcad-pla": { name: "House PLA", density: 1.3 }, "acme-pla": { name: "ACME PLA+", density: 1.27 } } }),
      },
      "model.fluid.js",
    );
    const list = host.getMaterials();
    expect(list).toHaveLength(MATERIALS.length + 1);
    expect(list.find((m) => m.id === "fluidcad-pla")).toEqual({ id: "fluidcad-pla", name: "House PLA", density: 1.3, densityUnit: "g/cm³", source: "project" });
    expect(list[list.length - 1].id).toBe("acme-pla");
    expect(host.resolveMaterial("acme-pla")?.name).toBe("ACME PLA+");
    expect(host.resolveMaterial("fluidcad-steel-1020")?.source).toBe("builtin");
    expect(host.resolveMaterial("unobtainium")).toBeUndefined();

    // A second install without the file drops the map again.
    host.setWorkspace({ "model.fluid.js": "" }, "model.fluid.js");
    expect(host.getMaterials()).toHaveLength(MATERIALS.length);
    expect(host.resolveMaterial("acme-pla")).toBeUndefined();
  });
});
