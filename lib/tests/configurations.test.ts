// `configurations({ rows })` inside a part() or assembly() body: the table of
// value sets for the body's param() interface. At root the host's active name
// picks the row and installs it as the registry's configuration layer
// (override → row → literal); from a parent, `insert(def, 'Name', extra)`
// picks the row per instance through the scope. Everything else — validation
// of the rows, the first-statement rule, the records and the serialized
// fields — is here too.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import param from "../core/param.js";
import part from "../core/part.js";
import assembly from "../core/assembly.js";
import insert from "../core/insert.js";
import replicate from "../core/replicate.js";
import mate from "../core/mate.js";
import connector from "../core/connector.js";
import select from "../core/select.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import configurations from "../core/configurations.js";
import { configurations as configurationsFromCore } from "../core/index.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { BrowserEngineHost } from "../browser/index.js";
import { createParamRegistry, type ParamRegistry, type ParamVal } from "../param-registry.js";
import { ParamKey } from "../param-key.js";
import { warnConfigurationRun } from "../features/param-overrides.js";
import { setupOC } from "./setup.js";

const PARAMS_FILE = "/ws/project.params.js";

function freshRegistry(overrides?: Record<string, ParamVal>, baselines?: Record<string, ParamVal>, active?: string): ParamRegistry {
  const registry = createParamRegistry();
  if (overrides) {
    registry.setOverrides(
      new Map(Object.entries(overrides)),
      baselines ? new Map(Object.entries(baselines)) : undefined,
    );
  }
  if (active !== undefined) {
    registry.setActiveConfiguration(active);
  }
  return registry;
}

function startAssembly(): AssemblyScene {
  getSceneManager().startScene();
  return getSceneManager().startAssemblyScene();
}

const warnings = (): string[] =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));

describe("configurations() — where it may stand", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
  });

  it("is the same function fluidcad/core exports", () => {
    expect(configurationsFromCore).toBe(configurations);
  });

  it("is refused outside every body, naming the rule and the params-file case", () => {
    freshRegistry();
    expect(() => configurations({ Wide: { Width: 1 } })).toThrow(/inside a part\(\) or assembly\(\) body/);
    expect(() => configurations({ Wide: { Width: 1 } })).toThrow(/\*\.params\.js file has no body/);
  });

  it("is refused at the top level of a *.params.js module", () => {
    freshRegistry();
    const wrapped = `"use strict";\nreturn configurations({ Wide: { Width: 1 } });\n//# sourceURL=${PARAMS_FILE}`;
    expect(() => new Function("configurations", wrapped)(configurations)).toThrow(/inside a part\(\) or assembly\(\) body/);
  });

  it("is refused after the body's first param(), with the fix", () => {
    freshRegistry();
    part("Plate", () => {
      param("Width", 100);
      configurations({ Wide: { Width: 200 } });
    });
    expect(() => getCurrentScene().materializeLeftoverDefinitions()).toThrow(
      /declare configurations\(\) before the body's first param\(\)/,
    );
  });

  it("is refused twice in one body — merge the rows", () => {
    freshRegistry();
    part("Plate", () => {
      configurations({ Wide: { Width: 200 } });
      configurations({ Tall: { Height: 300 } });
    });
    expect(() => getCurrentScene().materializeLeftoverDefinitions()).toThrow(/merge the rows/);
  });

  it("a nested part body gets its own frame — the parent's param() does not block it", () => {
    freshRegistry();
    startAssembly();
    const plate = part("Plate", () => {
      configurations({ Wide: { Width: 200 } });
      param("Width", 100);
    });
    const rig = assembly("rig", () => {
      param("Spacing", 40);
      return { p: insert(plate) };
    });
    expect(() => rig.run()).not.toThrow();
  });
});

describe("configurations() — the rows", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
  });

  function declaring(rows: unknown): () => void {
    return () => {
      // A fresh scene per table: a refused definition would otherwise be
      // re-materialized (and re-refused) by the next call's leftover pass.
      getSceneManager().startScene();
      part("Plate", () => {
        configurations(rows as Record<string, Record<string, ParamVal>>);
      });
      getCurrentScene().materializeLeftoverDefinitions();
    };
  }

  it("refuses 'Default' as a row name — it is the literals", () => {
    freshRegistry();
    expect(declaring({ Default: { Width: 1 } })).toThrow(/'Default' is reserved/);
  });

  it("refuses an empty row name", () => {
    freshRegistry();
    expect(declaring({ "  ": { Width: 1 } })).toThrow(/row name is empty/);
  });

  it("refuses a table that is not a plain object of plain objects", () => {
    freshRegistry();
    expect(declaring(null)).toThrow(/plain object of rows/);
    expect(declaring([{ Width: 1 }])).toThrow(/plain object of rows/);
    expect(declaring({ Wide: 5 })).toThrow(/row 'Wide' must be a plain object/);
    expect(declaring({ Wide: null })).toThrow(/row 'Wide' must be a plain object/);
  });

  it("refuses a cell no param() could produce", () => {
    freshRegistry();
    expect(declaring({ Wide: { Width: { nested: true } } })).toThrow(/row 'Wide': parameter 'Width' must be a number, string, boolean/);
  });

  it("accepts sparse rows and records the whole table", () => {
    const registry = freshRegistry();
    part("Plate", () => {
      configurations({ Compact: { Width: 50, Lid: false }, Wide: { Width: 200 } });
      param("Width", 100);
      param("Lid", true);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(registry.getConfigurations()).toEqual({
      active: "Default",
      names: ["Compact", "Wide"],
      rows: { Compact: { Width: 50, Lid: false }, Wide: { Width: 200 } },
    });
    expect(registry.getConfigurationTables()).toEqual([
      { definition: "Plate#1", name: "Plate", names: ["Compact", "Wide"], rows: { Compact: { Width: 50, Lid: false }, Wide: { Width: 200 } } },
    ]);
  });
});

describe("configurations() — root run", () => {
  setupOC();
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    createParamRegistry();
  });

  function plate(seen: Record<string, unknown>) {
    return part("Plate", () => {
      seen.configuration = configurations({ Compact: { Width: 50, Lid: false }, Wide: { Width: 200 } });
      seen.width = param("Width", 100);
      seen.lid = param("Lid", true);
    });
  }

  it("no active name: the literals, 'Default' returned, the table recorded", () => {
    const registry = freshRegistry();
    const seen: Record<string, unknown> = {};
    plate(seen);
    getCurrentScene().materializeLeftoverDefinitions();

    expect(seen).toEqual({ configuration: "Default", width: 100, lid: true });
    expect(registry.getConfigurations().active).toBe("Default");
    expect(registry.getConfigurations().names).toEqual(["Compact", "Wide"]);
    const width = registry.getDefinitions().find(d => d.label === "Width")!;
    expect(width.currentValue).toBe(100);
    expect(width.configuredValue).toBeUndefined();
  });

  it("an active name installs the row: row cells over the literals, absent labels keep theirs", () => {
    const registry = freshRegistry(undefined, undefined, "Compact");
    const seen: Record<string, unknown> = {};
    plate(seen);
    getCurrentScene().materializeLeftoverDefinitions();

    expect(seen).toEqual({ configuration: "Compact", width: 50, lid: false });
    expect(registry.getConfigurations().active).toBe("Compact");
    const width = registry.getDefinitions().find(d => d.label === "Width")!;
    expect(width.currentValue).toBe(50);
    expect(width.configuredValue).toBe(50);
    expect(width.defaultValue).toBe(100);
    expect(registry.getDefinitions().find(d => d.label === "Lid")!.configuredValue).toBe(false);
    expect(registry.getConfigurationValues("Plate#1")).toEqual(new Map<string, ParamVal>([["Width", 50], ["Lid", false]]));
  });

  it("a session override sits on top of the row", () => {
    const registry = freshRegistry({ Width: 75 }, { Width: 100 }, "Compact");
    const seen: Record<string, unknown> = {};
    plate(seen);
    getCurrentScene().materializeLeftoverDefinitions();

    expect(seen.width).toBe(75);
    expect(seen.lid).toBe(false);
    const width = registry.getDefinitions().find(d => d.label === "Width")!;
    expect(width.currentValue).toBe(75);
    expect(width.configuredValue).toBe(50);
  });

  it("a row cell is coerced to the literal's type", () => {
    freshRegistry(undefined, undefined, "Text");
    const seen: Record<string, unknown> = {};
    part("Plate", () => {
      configurations({ Text: { Width: "120" as unknown as number, Lid: "false" as unknown as boolean } });
      seen.width = param("Width", 100);
      seen.lid = param("Lid", true);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ width: 120, lid: false });
  });

  it("a changed literal still discards only the override — the row is a new base, never a discard", () => {
    // Baseline says the literal was 100 last run; the source now says 120.
    const registry = freshRegistry({ Width: 75 }, { Width: 100 }, "Compact");
    const seen: Record<string, unknown> = {};
    part("Plate", () => {
      configurations({ Compact: { Width: 50 } });
      seen.width = param("Width", 120);
    });
    getCurrentScene().materializeLeftoverDefinitions();

    // The label-only override and baseline stand for Plate's Width; the
    // verdict is filed under that parameter's key.
    expect(registry.getDiscardedOverrides()).toEqual([ParamKey.of("Plate#1", "Width").id]);
    expect(registry.getAuthoredDefaults().get(ParamKey.of("Plate#1", "Width").id)).toBe(120);
    // The override is gone; the row still applies.
    expect(seen.width).toBe(50);
  });

  it("a changed row cell under a stable literal discards nothing", () => {
    const registry = freshRegistry({ Width: 75 }, { Width: 100 }, "Compact");
    part("Plate", () => {
      configurations({ Compact: { Width: 60 } });
      param("Width", 100);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(registry.getDiscardedOverrides()).toEqual([]);
    expect(registry.getDefinitions().find(d => d.label === "Width")!.currentValue).toBe(75);
  });

  it("an unknown active name renders Default; the end-of-render check warns", () => {
    const registry = freshRegistry(undefined, undefined, "Huge");
    const seen: Record<string, unknown> = {};
    plate(seen);
    getCurrentScene().materializeLeftoverDefinitions();

    expect(seen).toEqual({ configuration: "Default", width: 100, lid: true });
    expect(registry.getConfigurations().active).toBe("Default");
    // The body itself is silent: another table could declare the name.
    expect(warnings()).toEqual([]);
    warnConfigurationRun(registry);
    expect(warnings()).toEqual([
      expect.stringMatching(/no table in this render declares 'Huge' — rendering Default\. Declared: 'Compact', 'Wide'\./),
    ]);
  });

  it("'Default' as the active name is the literals", () => {
    freshRegistry(undefined, undefined, "Default");
    const seen: Record<string, unknown> = {};
    plate(seen);
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen.configuration).toBe("Default");
    expect(seen.width).toBe(100);
  });

  it("the row a sub-assembly file's own body declares applies to its root run", () => {
    startAssembly();
    const registry = freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    const block = part("block", () => {});
    const frame = assembly("frame", () => {
      seen.configuration = configurations({ Wide: { Width: 1200 } });
      seen.width = param("Width", 700);
      return { b: insert(block) };
    });
    frame.run();
    expect(seen).toEqual({ configuration: "Wide", width: 1200 });
    expect(registry.getConfigurations()).toEqual({ active: "Wide", names: ["Wide"], rows: { Wide: { Width: 1200 } } });
  });

  it("two tables in one render: each body applies its own row, the listing merges; a duplicate row name across definitions warns", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    part("Plate", () => {
      configurations({ Wide: { Width: 200 } });
      seen.width = param("Width", 100);
    });
    part("Lid", () => {
      configurations({ Wide: { Depth: 30 }, Tall: { Depth: 60 } });
      seen.depth = param("Depth", 20);
    });
    getCurrentScene().materializeLeftoverDefinitions();

    expect(seen).toEqual({ width: 200, depth: 30 });
    expect(registry.getConfigurations().names).toEqual(["Wide", "Tall"]);
    expect(registry.getConfigurations().rows.Wide).toEqual({ Depth: 30 });
    expect(warnings()).toEqual([expect.stringMatching(/'Lid' and 'Plate' both declare 'Wide'/)]);
  });

  it("a row cell no param() reads is reported as unconsumed, and warned about per body at the end", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    part("Plate", () => {
      configurations({ Wide: { Width: 200, Colour: "red" } });
      param("Width", 100);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(registry.getUnconsumedConfigurationKeys()).toEqual(["Colour"]);
    expect(registry.getUnconsumedConfigurationCells()).toEqual([
      { kind: "part", definition: "Plate#1", name: "Plate", labels: ["Colour"], declared: ["Width"] },
    ]);
    warnConfigurationRun(registry);
    expect(warnings()).toEqual([
      expect.stringMatching(/part 'Plate': configuration 'Wide' sets unknown parameter 'Colour' — this body declared 'Width'\./),
    ]);
  });

  it("a paused render skips the end-of-render check — the pass stopped before the rest ran", () => {
    const registry = freshRegistry(undefined, undefined, "Huge");
    part("Plate", () => {
      configurations({ Wide: { Width: 200 } });
      param("Width", 100);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    warnConfigurationRun(registry, true);
    expect(warnings()).toEqual([]);
  });

  it("setConfiguration() needs a running body — a row is a body's layer", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    expect(() => registry.setConfiguration({ Width: 1 })).toThrow(/no part\(\) or assembly\(\) body is running/);
  });

  it("clear() forgets the active name, the layers, the tables and the body frames", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    registry.beginBody("x", "part");
    registry.setConfiguration({ Width: 1, Colour: "red" });
    registry.endBody();
    registry.recordConfigurations({ definition: "x", name: "x", names: ["Wide"], rows: { Wide: { Width: 1 } } });
    registry.beginBody("x", "part");
    expect(registry.getUnconsumedConfigurationKeys()).toEqual(["Width", "Colour"]);
    registry.clear();
    expect(registry.getActiveConfiguration()).toBeNull();
    expect(registry.getConfigurationValues("x").size).toBe(0);
    expect(registry.getUnconsumedConfigurationKeys()).toEqual([]);
    expect(registry.getConfigurations()).toEqual({ active: "Default", names: [], rows: {} });
    expect(registry.inBody()).toBe(false);
  });
});

describe("configurations() — the root layer is per body", () => {
  setupOC();
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    createParamRegistry();
  });

  /** Two parts of one file, both declaring `Width`; each table's rows are its own. */
  function twoParts(seen: Record<string, unknown>, aRows: Record<string, Record<string, ParamVal>>, bRows?: Record<string, Record<string, ParamVal>>) {
    const a = part("A", () => {
      seen.aConfiguration = configurations(aRows);
      seen.aWidth = param("Width", 100);
    });
    const b = part("B", () => {
      if (bRows) {
        seen.bConfiguration = configurations(bRows);
      }
      seen.bWidth = param("Width", 10);
    });
    return { a, b };
  }

  it("a row in A's table does not set B's same-named param, and vice versa", () => {
    freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    twoParts(seen, { Wide: { Width: 200 } });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ aConfiguration: "Wide", aWidth: 200, bWidth: 10 });

    // The other way round: the row is B's, A keeps its literal.
    getSceneManager().startScene();
    const registry = freshRegistry(undefined, undefined, "Narrow");
    const other: Record<string, unknown> = {};
    twoParts(other, {}, { Narrow: { Width: 5 } });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(other).toEqual({ aConfiguration: "Default", aWidth: 100, bConfiguration: "Narrow", bWidth: 5 });
    // Each part's Width is its own definition, keyed by its body.
    expect(registry.getDefinitions().filter(d => d.label === "Width").map(d => d.body)).toEqual(["A#1", "B#1"]);
    const width = registry.getDefinitions().find(d => d.label === "Width" && d.body === "B#1")!;
    expect(width.currentValue).toBe(5);
    expect(width.configuredValue).toBe(5);
    const aWidth = registry.getDefinitions().find(d => d.label === "Width" && d.body === "A#1")!;
    expect(aWidth.currentValue).toBe(100);
    expect(aWidth.configuredValue).toBeUndefined();
    expect(registry.getConfigurationValues("A#1").size).toBe(0);
    expect(registry.getConfigurationValues("B#1")).toEqual(new Map<string, ParamVal>([["Width", 5]]));
  });

  it("each body applies its own table's cells for the same row name", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    twoParts(seen, { Wide: { Width: 200 } }, { Wide: { Width: 20 } });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ aConfiguration: "Wide", aWidth: 200, bConfiguration: "Wide", bWidth: 20 });
    expect(registry.getConfigurations().active).toBe("Wide");
    expect(registry.getConfigurationValues("A#1")).toEqual(new Map<string, ParamVal>([["Width", 200]]));
    expect(registry.getConfigurationValues("B#1")).toEqual(new Map<string, ParamVal>([["Width", 20]]));
    // Every cell was read by its own body: nothing unconsumed, nothing warned
    // past the duplicate-name notice.
    warnConfigurationRun(registry);
    expect(registry.getUnconsumedConfigurationKeys()).toEqual([]);
    expect(warnings()).toEqual([expect.stringMatching(/'B' and 'A' both declare 'Wide'/)]);
  });

  it("a row declared only in A: B renders Default with no warning", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    twoParts(seen, { Wide: { Width: 200 } }, { Tall: { Width: 30 } });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ aConfiguration: "Wide", aWidth: 200, bConfiguration: "Default", bWidth: 10 });
    expect(registry.getConfigurations()).toEqual({
      active: "Wide",
      names: ["Wide", "Tall"],
      rows: { Wide: { Width: 200 }, Tall: { Width: 30 } },
    });
    warnConfigurationRun(registry);
    expect(warnings()).toEqual([]);
  });

  it("an active name no table declares warns exactly once, listing every table's rows", () => {
    const registry = freshRegistry(undefined, undefined, "Huge");
    const seen: Record<string, unknown> = {};
    twoParts(seen, { Wide: { Width: 200 } }, { Tall: { Width: 30 } });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ aConfiguration: "Default", aWidth: 100, bConfiguration: "Default", bWidth: 10 });
    expect(warnings()).toEqual([]);
    warnConfigurationRun(registry);
    expect(warnings()).toEqual([
      expect.stringMatching(/no table in this render declares 'Huge' — rendering Default\. Declared: 'Wide', 'Tall'\./),
    ]);
  });

  it("an active name in a render with no table at all warns that nothing declares it", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    part("Plate", () => {
      param("Width", 100);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    warnConfigurationRun(registry);
    expect(warnings()).toEqual([
      expect.stringMatching(/no table in this render declares 'Wide' — rendering Default\. The render declares no configurations\(\) table\./),
    ]);
  });

  it("a part built lazily after the module (the leftover pass) reads its own row", () => {
    freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    const { b } = twoParts(seen, { Wide: { Width: 200 } }, { Wide: { Width: 20 } });
    // Nothing has built yet: part() is lazy.
    expect(seen).toEqual({});
    // B is read first (built on demand), A only by the leftover pass.
    b.materializeInto(getCurrentScene());
    expect(seen).toEqual({ bConfiguration: "Wide", bWidth: 20 });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ bConfiguration: "Wide", bWidth: 20, aConfiguration: "Wide", aWidth: 200 });
  });

  it("a part built inside another part's body reads its own row, and the outer body keeps its row after", () => {
    freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    const inner = part("Inner", () => {
      seen.innerConfiguration = configurations({ Wide: { Width: 20 } });
      seen.innerWidth = param("Width", 10);
      seen.innerDepth = param("Depth", 4);
    });
    part("Outer", () => {
      seen.outerConfiguration = configurations({ Wide: { Width: 200, Depth: 40 } });
      seen.outerBefore = param("Width", 100);
      // Reading the definition's geometry mid-body builds it here, nested.
      inner.materializeInto(getCurrentScene());
      seen.outerAfter = param("Depth", 30);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({
      outerConfiguration: "Wide",
      outerBefore: 200,
      innerConfiguration: "Wide",
      innerWidth: 20,
      // Outer's row names Depth; Inner's does not, and Outer's is not Inner's.
      innerDepth: 4,
      outerAfter: 40,
    });
  });

  it("an inner part without a table builds its literals inside a configured outer body", () => {
    freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    const inner = part("Inner", () => {
      seen.innerWidth = param("Width", 10);
    });
    part("Outer", () => {
      configurations({ Wide: { Width: 200 } });
      inner.materializeInto(getCurrentScene());
      seen.outerWidth = param("Width", 100);
    });
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ innerWidth: 10, outerWidth: 200 });
  });

  it("an assembly's row does not reach a part built unscoped inside its body", () => {
    startAssembly();
    freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    const block = part("block", () => {
      seen.blockWidth = param("Width", 10);
    });
    const frame = assembly("frame", () => {
      configurations({ Wide: { Width: 1200 } });
      seen.frameWidth = param("Width", 700);
      block.materializeInto(getCurrentScene());
      return {};
    });
    frame.run();
    expect(seen).toEqual({ frameWidth: 1200, blockWidth: 10 });
  });
});

describe("insert(def, 'Name', overrides?)", () => {
  setupOC();
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    createParamRegistry();
  });

  function housing(runs: Record<string, unknown>[] = []) {
    return part("housing", () => {
      const configuration = configurations({ Compact: { Width: 50, Depth: 60 }, Wide: { Width: 1200 } });
      const width = param("Width", 700);
      const depth = param("Depth", 400);
      runs.push({ configuration, width, depth });
    });
  }

  it("resolves the row per instance and records the configuration", () => {
    const scene = startAssembly();
    freshRegistry();
    const runs: Record<string, unknown>[] = [];
    const def = housing(runs);
    const wide = insert(def, "Wide");

    expect(runs).toEqual([{ configuration: "Wide", width: 1200, depth: 400 }]);
    expect(wide.record.configuration).toBe("Wide");
    expect(wide.record.part.paramValues).toEqual({ Width: 1200, Depth: 400 });
    expect(wide.record.part.params?.find(p => p.label === "Width")?.configuredValue).toBe(1200);
    expect(wide.record.part.params?.find(p => p.label === "Depth")?.configuredValue).toBeUndefined();
    const serialized = scene.getSerializedInstances()[0];
    expect(serialized.configuration).toBe("Wide");
    expect(serialized.paramValues).toEqual({ Width: 1200, Depth: 400 });
    // The template carries the table's names, so a consumer can offer the other rows.
    expect(wide.record.part.configurations).toEqual(["Compact", "Wide"]);
    expect(wide.record.part.serialize().configurations).toEqual(["Compact", "Wide"]);
  });

  it("layers the override object on top of the row", () => {
    startAssembly();
    freshRegistry();
    const runs: Record<string, unknown>[] = [];
    const def = housing(runs);
    insert(def, "Wide", { Depth: 1000 });
    expect(runs).toEqual([{ configuration: "Wide", width: 1200, depth: 1000 }]);
  });

  it("a plain insert runs the literals, returns 'Default' and records no configuration", () => {
    const scene = startAssembly();
    freshRegistry();
    const runs: Record<string, unknown>[] = [];
    const def = housing(runs);
    const inst = insert(def);
    const other = insert(def, { Width: 900 });
    expect(runs).toEqual([
      { configuration: "Default", width: 700, depth: 400 },
      { configuration: "Default", width: 900, depth: 400 },
    ]);
    expect(inst.record.configuration).toBeUndefined();
    expect(other.record.configuration).toBeUndefined();
    expect("configuration" in scene.getSerializedInstances()[0]).toBe(false);
    // The names still travel on a plain insert — the dialog offers the rows from the literals too.
    expect(inst.record.part.configurations).toEqual(["Compact", "Wide"]);
  });

  it("'Default' as the name is the literals and records nothing", () => {
    startAssembly();
    freshRegistry();
    const runs: Record<string, unknown>[] = [];
    const inst = insert(housing(runs), "Default", { Depth: 10 });
    expect(runs).toEqual([{ configuration: "Default", width: 700, depth: 10 }]);
    expect(inst.record.configuration).toBeUndefined();
  });

  it("two inserts of one name share a template; a name and its equal value object do not", () => {
    // The configuration name is part of the variant key, not expanded into
    // values: the row is only known once the body runs, after the cache is
    // consulted. So 'Wide' twice is one build, while 'Wide' and
    // { Width: 1200 } are two templates even though their values agree.
    const scene = startAssembly();
    freshRegistry();
    const runs: Record<string, unknown>[] = [];
    const def = housing(runs);
    const a = insert(def, "Wide");
    const b = insert(def, "Wide");
    const c = insert(def, { Width: 1200 });
    expect(a.record.part).toBe(b.record.part);
    expect(c.record.part).not.toBe(a.record.part);
    expect(runs).toHaveLength(2);
    expect(def.builtVariantsIn(scene)).toHaveLength(2);
    // A name with overrides is a third variant.
    insert(def, "Wide", { Depth: 1000 });
    expect(def.builtVariantsIn(scene)).toHaveLength(3);
  });

  it("an unknown name throws from the body with the declared names listed", () => {
    startAssembly();
    freshRegistry();
    expect(() => insert(housing(), "Huge")).toThrow(
      /'housing' has no configuration 'Huge' — its configurations\(\) declares 'Compact', 'Wide'\./,
    );
  });

  it("a name for a definition without a table builds the literals and warns", () => {
    startAssembly();
    freshRegistry();
    const plain = part("plain", () => { param("Width", 1); });
    // No configurations() ran, so nothing could look the row up: the
    // literals build, the record keeps the name, and the parent is told.
    const inst = insert(plain, "Wide");
    expect(inst.record.configuration).toBe("Wide");
    expect(inst.record.part.paramValues).toEqual({ Width: 1 });
    expect(warnings()).toEqual([
      expect.stringMatching(/part 'plain': inserted with configuration 'Wide', but its body declares no configurations\(\) — the literals were built\./),
    ]);
  });

  it("refuses the name on a built part, and overrides in the third position without a name", () => {
    startAssembly();
    freshRegistry();
    const def = housing();
    const built = def.materializeVariant(getCurrentScene());
    const untyped = insert as unknown as (...args: unknown[]) => unknown;
    expect(() => untyped(built, "Wide")).toThrow(/a configuration name needs a part definition — this part is already built/);
    expect(() => insert(def, "")).toThrow(/configuration name is empty/);
    expect(() => (insert as unknown as (...args: unknown[]) => unknown)(def, { Width: 1 }, { Depth: 2 })).toThrow(
      /overrides go in the second position unless a configuration name comes first/,
    );
  });

  it("warns about a row cell the body never read, naming the configuration", () => {
    startAssembly();
    freshRegistry();
    const def = part("housing", () => {
      configurations({ Wide: { Width: 1200, Colour: "red" } });
      param("Width", 700);
    });
    insert(def, "Wide", { Lenght: 5 });
    expect(warnings()).toEqual([
      expect.stringMatching(/part 'housing': unknown parameter override 'Lenght' — this build declared 'Width'\./),
      expect.stringMatching(/part 'housing': configuration 'Wide' sets unknown parameter 'Colour' — this build declared 'Width'\./),
    ]);
  });

  it("builds a sub-assembly occurrence from a row and serializes it", () => {
    const scene = startAssembly();
    freshRegistry();
    const block = part("block", () => {});
    const runs: Record<string, unknown>[] = [];
    const frame = assembly("frame", () => {
      const configuration = configurations({ Wide: { Width: 1200 }, Compact: { Width: 500, Depth: 600 } });
      runs.push({ configuration, width: param("Width", 700), depth: param("Depth", 400) });
      return { b: insert(block) };
    });
    const occ = insert(frame, "Compact", { Depth: 650 });
    expect(runs).toEqual([{ configuration: "Compact", width: 500, depth: 650 }]);
    expect(occ.record.configuration).toBe("Compact");
    expect(occ.record.paramValues).toEqual({ Width: 500, Depth: 650 });
    const serialized = scene.getSerializedOccurrences()[0];
    expect(serialized.configuration).toBe("Compact");
    expect(serialized.paramValues).toEqual({ Width: 500, Depth: 650 });
    expect(serialized.configurations).toEqual(["Wide", "Compact"]);
    expect(() => insert(frame, "Huge")).toThrow(/'frame' has no configuration 'Huge' — its configurations\(\) declares 'Wide', 'Compact'\./);
  });

  it("a replica repeats its seed's configuration", () => {
    const scene = startAssembly();
    freshRegistry();
    const rail = part("rail", () => {
      sketch("xy", () => { testRect(60, 20); });
      extrude(10);
      connector("s1", select(face().planar().onPlane("xy", 10)));
      connector("s2", select(face().planar().onPlane("xy", 10)));
      connector("s3", select(face().planar().onPlane("xy", 10)));
    });
    const block = part("block", () => {
      configurations({ Tall: { Height: 30 } });
      const h = param("Height", 10);
      sketch("xy", () => { testRect(20, 20); });
      extrude(h);
      connector("bottom", select(face().planar().onPlane("xy", 0)));
    });
    const base = insert(rail).grounded();
    const tall = insert(block, "Tall");
    mate("fastened", tall.connectors.bottom, base.connectors.s1);
    const copies = replicate(tall, [base.connectors.s1], [[base.connectors.s2], [base.connectors.s3]]);
    expect(copies).toHaveLength(2);
    expect(copies.every(c => c.record.part === tall.record.part)).toBe(true);
    const configured = scene.getSerializedInstances().filter(i => i.configuration === "Tall");
    expect(configured.map(i => i.instanceId)).toEqual([tall.record.instanceId, ...copies.map(c => c.record.instanceId)]);
  });
});

describe("BrowserEngineHost.setConfiguration", () => {
  const host = new BrowserEngineHost();
  const seen: Record<string, unknown>[] = [];
  const evaluator = async () => {
    const plate = part("Plate", () => {
      const configuration = configurations({ Wide: { Width: 200 } });
      const width = param("Width", 100);
      seen.push({ configuration, width });
      sketch("xy", () => { testRect(width, 20); });
      extrude(10);
    });
    return { plate };
  };
  const width = (outcome: { params?: { label: string; currentValue: unknown; configuredValue?: unknown }[] }) =>
    outcome.params?.find(p => p.label === "Width");

  it("mirrors setParam: the row on the next pass, overrides on top, the table in the result", async () => {
    await host.init();
    host.setWorkspace({ "plate.part.js": "unused-by-this-evaluator" }, "plate.part.js");
    host.setModuleEvaluator(evaluator);

    // The literals by default, the table reported next to params.
    let outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(outcome.configurations).toEqual({ active: "Default", names: ["Wide"], rows: { Wide: { Width: 200 } } });
    expect(seen.at(-1)).toEqual({ configuration: "Default", width: 100 });

    // Switch the row: the registry's active name is set before the pass.
    outcome = await host.setConfiguration("Wide");
    expect(outcome.compileError).toBeNull();
    expect(outcome.configurations?.active).toBe("Wide");
    expect(width(outcome)?.currentValue).toBe(200);
    expect(width(outcome)?.configuredValue).toBe(200);
    expect(seen.at(-1)).toEqual({ configuration: "Wide", width: 200 });

    // A session override sits on top of the row; reset returns to the row.
    outcome = await host.setParam("Width", 150);
    expect(width(outcome)?.currentValue).toBe(150);
    expect(width(outcome)?.configuredValue).toBe(200);
    expect(outcome.configurations?.active).toBe("Wide");
    outcome = await host.resetParams();
    expect(width(outcome)?.currentValue).toBe(200);

    // An unknown name renders Default and says so in the summary.
    outcome = await host.setConfiguration("Huge");
    expect(outcome.compileError).toBeNull();
    expect(outcome.configurations?.active).toBe("Default");
    expect(width(outcome)?.currentValue).toBe(100);

    // 'Default' clears the name; unloading forgets it.
    outcome = await host.setConfiguration("Default");
    expect(host.getActiveConfiguration()).toBeNull();
    expect(outcome.configurations?.active).toBe("Default");
    expect(width(outcome)?.currentValue).toBe(100);
    await host.setConfiguration("Wide");
    host.unloadModel();
    expect(host.getActiveConfiguration()).toBeNull();
  });
});
