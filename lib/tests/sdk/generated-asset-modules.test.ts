// Where a generated definition's images resolve (GeneratedAssetModules): the
// module that defines it and the module that declared its class's values —
// the one that called Feature.with() / Generator.with(). A host serves and
// packs the schema's images with them. And the render's export rule: an
// exported class is a declaration, never a factory a host calls.

import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { definePart, defineAssembly, Feature, Generator } from "../../sdk/index.js";
import { GeneratedSchemas } from "../../sdk/generated-schema.js";
import { ClassModules } from "../../sdk/class-modules.js";
import { ModuleExports } from "../../common/module-exports.js";
import { defineSpur } from "../fixtures/custom-features/spur.js";
import { defineCabinet } from "../fixtures/custom-features/cabinet.js";

const SPUR_MODULE = /\/lib\/tests\/fixtures\/custom-features\/spur\.ts$/;
const CABINET_MODULE = /\/lib\/tests\/fixtures\/custom-features\/cabinet\.ts$/;

describe("GeneratedSchemas.modulesOf", () => {
  setupOC();

  it("names the feature's module as a generated part's class base", () => {
    const { Spur } = defineSpur();
    const modules = GeneratedSchemas.modulesOf(definePart(Spur, { label: "Spur" }));
    expect(modules?.class).toMatch(SPUR_MODULE);
  });

  it("names the generator's module as a generated assembly's class base", () => {
    const { Cabinet } = defineCabinet();
    const modules = GeneratedSchemas.modulesOf(defineAssembly(Cabinet, { label: "Cabinet" }));
    expect(modules?.class).toMatch(CABINET_MODULE);
  });

  it("names the module that calls definePart() / defineAssembly() as the definition base", () => {
    const { Spur } = defineSpur();
    const { Cabinet } = defineCabinet();
    const file = "/ws/parts/spur.part.js";
    const part = new Function("definePart", "Spur", `return definePart(Spur, { label: 'Spur' });\n//# sourceURL=${file}`)(definePart, Spur);
    expect(GeneratedSchemas.modulesOf(part)?.definition).toBe(file);
    const assemblyFile = "/ws/assemblies/cabinet.assembly.js";
    const assembly = new Function("defineAssembly", "Cabinet", `return defineAssembly(Cabinet, { label: 'Cabinet' });\n//# sourceURL=${assemblyFile}`)(defineAssembly, Cabinet);
    expect(GeneratedSchemas.modulesOf(assembly)?.definition).toBe(assemblyFile);
  });

  it("answers for every class that extends a .with() base, and null for anything else", () => {
    class Plain extends Feature.with({ size: { type: "length", default: 1 } }) {
      static id = "acme.plain";
    }
    class Deeper extends Plain {}
    expect(ClassModules.of(Deeper)).toMatch(/generated-asset-modules\.test\.ts$/);
    class Shelf extends Generator.with({ width: { type: "length", default: 1 } }) {
      static id = "acme.shelf";
      layout() {
        return {};
      }
    }
    expect(ClassModules.of(Shelf)).toMatch(/generated-asset-modules\.test\.ts$/);
    expect(ClassModules.of(class Unrelated {})).toBeNull();
    expect(GeneratedSchemas.modulesOf({})).toBeNull();
    expect(GeneratedSchemas.modulesOf(null)).toBeNull();
  });
});

describe("ModuleExports", () => {
  it("never calls a class, and calls every other function once", async () => {
    class Shelf extends Generator.with({ width: { type: "length", default: 1 } }) {
      static id = "acme.shelf";
      layout() {
        return {};
      }
    }
    let calls = 0;
    const factory = () => {
      calls++;
      return "built";
    };
    expect(ModuleExports.isClass(Shelf)).toBe(true);
    expect(ModuleExports.isClass(class {})).toBe(true);
    expect(ModuleExports.isClass(factory)).toBe(false);
    expect(ModuleExports.isClass(function legacy() {})).toBe(false);
    expect(ModuleExports.isClass(42)).toBe(false);
    expect(await ModuleExports.resolve(Shelf)).toBe(Shelf);
    expect(await ModuleExports.resolve(factory)).toBe("built");
    expect(await ModuleExports.resolve(async () => "later")).toBe("later");
    expect(await ModuleExports.resolve(7)).toBe(7);
    expect(calls).toBe(1);
  });
});
