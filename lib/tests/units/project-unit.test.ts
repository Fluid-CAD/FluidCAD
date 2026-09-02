import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { createProjectUnitLookup, readProjectUnit, resolveProjectUnit } from "../../project-unit.js";

const root = fs.mkdtempSync(join(os.tmpdir(), "fluidcad-units-"));
const ws = join(root, "ws");

function write(rel: string, content: string): string {
  const abs = join(ws, rel);
  fs.mkdirSync(join(abs, ".."), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("fluidcad.json project unit", () => {
  beforeAll(() => {
    write("fluidcad.json", JSON.stringify({ engine: "0.0.42", unit: "in" }));
    write("sub/fluidcad.json", JSON.stringify({ unit: "centimeters" }));
    write("sub/deep/model.part.js", "");
    write("other/model.part.js", "");
    write("bad/fluidcad.json", JSON.stringify({ unit: "furlong" }));
    write("bad/model.part.js", "");
    write("broken/fluidcad.json", "{ not json");
    write("node_modules/pkg/package.json", "{}");
    write("node_modules/pkg/fluidcad.json", JSON.stringify({ unit: "m" }));
    write("node_modules/pkg/lib/x.part.js", "");
    write("node_modules/plain/package.json", "{}");
    write("node_modules/plain/x.part.js", "");
    fs.mkdirSync(join(root, "outside"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("readProjectUnit reads only the unit key", () => {
    expect(readProjectUnit(ws)).toBe("in");
    expect(readProjectUnit(join(ws, "sub"))).toBe("cm");
    expect(readProjectUnit(join(ws, "other"))).toBeNull();
    expect(readProjectUnit(join(root, "outside"))).toBeNull();
    expect(readProjectUnit("")).toBeNull();
  });

  it("ignores invalid values with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readProjectUnit(join(ws, "bad"))).toBeNull();
      expect(readProjectUnit(join(ws, "broken"))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolveProjectUnit: init option beats fluidcad.json beats mm", () => {
    expect(resolveProjectUnit(ws, { unit: "feet" })).toBe("ft");
    expect(resolveProjectUnit(ws)).toBe("in");
    expect(resolveProjectUnit(join(root, "outside"))).toBe("mm");
    expect(resolveProjectUnit("")).toBe("mm");
    expect(() => resolveProjectUnit(ws, { unit: "furlong" })).toThrow(/Unknown length unit/);
  });

  it("walks up to the nearest fluidcad.json, stopping at the workspace root", () => {
    const lookup = createProjectUnitLookup(ws)!;
    expect(lookup(join(ws, "sub/deep/model.part.js"))).toBe("cm");
    expect(lookup(join(ws, "other/model.part.js"))).toBe("in");
    expect(lookup(join(ws, "model.part.js"))).toBe("in");
    expect(lookup("relative/model.part.js")).toBeNull();
    expect(lookup("")).toBeNull();
  });

  it("does not walk past the workspace root", () => {
    fs.writeFileSync(join(root, "fluidcad.json"), JSON.stringify({ unit: "ft" }));
    try {
      const lookup = createProjectUnitLookup(ws)!;
      expect(lookup(join(ws, "other/model.part.js"))).toBe("in");
      // A file outside the workspace walks to the filesystem root.
      expect(lookup(join(root, "outside/model.part.js"))).toBe("ft");
    } finally {
      fs.rmSync(join(root, "fluidcad.json"));
    }
  });

  it("stops at a node_modules package root", () => {
    const lookup = createProjectUnitLookup(ws)!;
    expect(lookup(join(ws, "node_modules/pkg/lib/x.part.js"))).toBe("m");
    // The package has no fluidcad.json: the enclosing workspace's unit is NOT inherited.
    expect(lookup(join(ws, "node_modules/plain/x.part.js"))).toBeNull();
  });

  it("caches per lookup instance", () => {
    const lookup = createProjectUnitLookup(ws)!;
    expect(lookup(join(ws, "other/model.part.js"))).toBe("in");
    fs.writeFileSync(join(ws, "other/fluidcad.json"), JSON.stringify({ unit: "m" }));
    try {
      expect(lookup(join(ws, "other/model.part.js"))).toBe("in");
      expect(createProjectUnitLookup(ws)!(join(ws, "other/model.part.js"))).toBe("m");
    } finally {
      fs.rmSync(join(ws, "other/fluidcad.json"));
    }
  });
});
