// Global (project) parameters: a `param()` at the top level of a `*.params.js`
// module registers as `kind: 'global'` whose value is its literal — no session
// override, no baseline bookkeeping — while a top-level call in a model file
// is still refused, and a call inside a part or assembly body is untouched.
// Snippets run through `new Function` with a `//# sourceURL` so
// captureSourceLocation resolves real frames: the decision reads the stack,
// so the production attribution path is what is exercised, not a stub.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import param, { classifyTopLevelParam } from "../core/param.js";
import part from "../core/part.js";
import assembly from "../core/assembly.js";
import insert from "../core/insert.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { createParamRegistry, type ParamDefinition, type ParamRegistry, type ParamVal } from "../param-registry.js";
import { isFluidScriptFile, isParamsFile } from "../index.js";
import { setupOC } from "./setup.js";

const PARAMS_FILE = "/ws/project.params.js";
const PART_FILE = "/ws/bracket.part.js";

/** Run `code` as the top level of a module attributed to `file`, with `param` in scope. */
function runTopLevel(file: string, code: string): unknown {
  const wrapped = `"use strict";\nreturn (() => {\n${code}\n})();\n//# sourceURL=${file}`;
  return new Function("param", wrapped)(param);
}

function freshRegistry(overrides?: Record<string, ParamVal>, baselines?: Record<string, ParamVal>): ParamRegistry {
  const registry = createParamRegistry();
  if (overrides) {
    registry.setOverrides(
      new Map(Object.entries(overrides)),
      baselines ? new Map(Object.entries(baselines)) : undefined,
    );
  }
  return registry;
}

function byLabel(definitions: ParamDefinition[], label: string): ParamDefinition {
  const found = definitions.find((d) => d.label === label);
  expect(found, `no definition for ${label}`).toBeDefined();
  return found!;
}

describe("isParamsFile", () => {
  it("names the global-parameters module by its suffix", () => {
    expect(isParamsFile("/ws/project.params.js")).toBe(true);
    expect(isParamsFile("tolerances.params.js")).toBe(true);
    expect(isParamsFile("/ws/bracket.part.js")).toBe(false);
    expect(isParamsFile("/ws/params.js")).toBe(false);
  });

  it("is a script the engine attributes frames to", () => {
    expect(isFluidScriptFile("/ws/project.params.js")).toBe(true);
  });
});

describe("param() at module top level", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
  });

  it("registers a project parameter from a *.params.js module", () => {
    const registry = freshRegistry();
    const value = runTopLevel(PARAMS_FILE, `return param("Wall thickness", 3, "number", { min: 1, max: 10, step: 0.5 });`);

    expect(value).toBe(3);
    const wall = byLabel(registry.getDefinitions(), "Wall thickness");
    expect(wall.kind).toBe("global");
    expect(wall.currentValue).toBe(3);
    expect(wall.controlType).toBe("number");
    expect(wall.min).toBe(1);
    expect(wall.sourceLocation?.filePath).toBe(PARAMS_FILE);
    expect(wall.part).toBeUndefined();
    expect("part" in wall).toBe(false);
  });

  it("returns the literal even when a session override for the label is installed", () => {
    const registry = freshRegistry({ "Wall thickness": 7 }, { "Wall thickness": 3 });
    const value = runTopLevel(PARAMS_FILE, `return param("Wall thickness", 3);`);

    expect(value).toBe(3);
    expect(byLabel(registry.getDefinitions("global"), "Wall thickness").currentValue).toBe(3);
  });

  it("never touches the override baselines — nothing authored, nothing discarded", () => {
    // A re-authored literal under an override would discard that override
    // for a part parameter; a global is not that machinery's business.
    const registry = freshRegistry({ Width: 250 }, { Width: 300 });
    runTopLevel(PARAMS_FILE, `param("Width", 120);`);

    expect(registry.getAuthoredDefaults().size).toBe(0);
    expect(registry.getDiscardedOverrides()).toEqual([]);
  });

  it("is refused in a model file, pointing at both legal homes", () => {
    freshRegistry();
    expect(() => runTopLevel(PART_FILE, `param("Width", 100);`)).toThrow(
      /param\('Width'\) must be declared inside a part\(\) body — move it to the top of the part's callback, or export it from a \*\.params\.js file to share it across the project\./,
    );
  });

  it("registers nothing when refused", () => {
    const registry = freshRegistry();
    expect(() => runTopLevel(PART_FILE, `param("Width", 100);`)).toThrow();
    expect(registry.getDefinitions()).toEqual([]);
  });

  it("degrades to a project parameter when the call cannot be attributed to a file", () => {
    // A test module is no fluid script: the stack carries no attributable
    // frame, as the browser viewer's evaluator may not. A viewer renders over
    // missing attribution; it never throws.
    const registry = freshRegistry({ Depth: 99 });
    const value = param("Depth", 25);

    expect(value).toBe(25);
    const depth = byLabel(registry.getDefinitions(), "Depth");
    expect(depth.kind).toBe("global");
    expect(depth.sourceLocation).toBeUndefined();
  });

  it("classifyTopLevelParam decides from the location alone", () => {
    expect(classifyTopLevelParam("X", null)).toBe("global");
    expect(classifyTopLevelParam("X", { filePath: PARAMS_FILE, line: 1, column: 0 })).toBe("global");
    expect(() => classifyTopLevelParam("X", { filePath: PART_FILE, line: 1, column: 0 })).toThrow(/\*\.params\.js/);
    expect(() => classifyTopLevelParam("X", { filePath: "/ws/model.fluid.js", line: 1, column: 0 })).toThrow(/part\(\) body/);
    expect(() => classifyTopLevelParam("X", { filePath: "/ws/rig.assembly.js", line: 1, column: 0 })).toThrow(/part\(\) body/);
  });
});

describe("param() inside a body — unchanged", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
  });

  it("is a part parameter stamped with its part, and honors a session override", () => {
    const registry = freshRegistry({ Width: 160 }, { Width: 100 });
    const seen: unknown[] = [];
    // The part() statement runs in an attributed frame, as in a real file,
    // so the declaration is stamped with the statement that owns it.
    new Function("part", "param", "seen",
      `"use strict";\npart("Plate", () => { seen.push(param("Width", 100)); });\n//# sourceURL=${PART_FILE}`,
    )(part, param, seen);
    getCurrentScene().materializeLeftoverDefinitions();

    expect(seen).toEqual([160]);
    const width = byLabel(registry.getDefinitions(), "Width");
    expect(width.kind).toBe("part");
    expect(width.part?.filePath).toBe(PART_FILE);
    expect(width.sourceLocation?.filePath).toBe(PART_FILE);
    expect(width.currentValue).toBe(160);
    expect(registry.getAuthoredDefaults().get("Width")).toBe(100);
  });

  it("is an assembly parameter inside an assembly body", () => {
    getSceneManager().startScene();
    const block = part("block", () => {});
    getSceneManager().startAssemblyScene();
    const registry = freshRegistry();
    const def = assembly("rig", () => { param("Spacing", 40); return { b: insert(block) }; });
    def.run();

    const spacing = byLabel(registry.getDefinitions(), "Spacing");
    expect(spacing.kind).toBe("assembly");
    expect(spacing.part).toBeUndefined();
  });

  it("filters definitions by kind", () => {
    const registry = freshRegistry();
    runTopLevel(PARAMS_FILE, `param("Wall", 3);`);
    part("Plate", () => { param("Width", 100); });
    getCurrentScene().materializeLeftoverDefinitions();

    expect(registry.getDefinitions().map((d) => d.label).sort()).toEqual(["Wall", "Width"]);
    expect(registry.getDefinitions("global").map((d) => d.label)).toEqual(["Wall"]);
    expect(registry.getDefinitions("part").map((d) => d.label)).toEqual(["Width"]);
    expect(registry.getDefinitions("assembly")).toEqual([]);
    expect(registry.hasGlobal("Wall")).toBe(true);
    expect(registry.hasGlobal("Width")).toBe(false);
  });
});

describe("insert() override naming a project parameter", () => {
  setupOC();
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    createParamRegistry();
  });

  it("warns that the key is edited in the Parameters panel, not per instance", () => {
    freshRegistry();
    runTopLevel(PARAMS_FILE, `param("Wall thickness", 3);`);
    getSceneManager().startAssemblyScene();
    const def = part("housing", () => { param("Length", 100); });
    insert(def, { "Wall thickness": 5 } as any);

    expect(console.warn).toHaveBeenCalledTimes(1);
    const message = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(message).toContain("unknown parameter override 'Wall thickness'");
    expect(message).toContain("'Wall thickness' is a project parameter — edit it in the Parameters panel, not per instance.");
  });

  it("keeps the plain wording for a key that names no parameter at all", () => {
    freshRegistry();
    getSceneManager().startAssemblyScene();
    const def = part("housing", () => { param("Length", 100); });
    insert(def, { Lenght: 50 } as any);

    const message = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(message).toContain("'Lenght'");
    expect(message).not.toContain("project parameter");
  });
});
