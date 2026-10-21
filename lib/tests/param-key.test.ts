// A parameter is identified by the body that declared it plus its label
// (`ParamKey`): two part() bodies of one file that both declare `Width` are
// two parameters — two definitions, two session overrides, two baselines,
// each with its own configured value. A reference by label alone still
// works while one body declares the label, and is refused when several do.

import { describe, it, expect, afterEach, vi } from "vitest";
import param from "../core/param.js";
import part from "../core/part.js";
import configurations from "../core/configurations.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { testRect } from "./helpers/profiles.js";
import { getCurrentScene } from "../scene-manager.js";
import { BrowserEngineHost } from "../browser/index.js";
import { createParamRegistry, ParamRegistry, type ParamDefinition, type ParamVal } from "../param-registry.js";
import { ParamKey } from "../param-key.js";
import { PartDefinition } from "../features/part-definition.js";
import { SessionParamOverrides } from "../session-param-overrides.js";
import { setupOC } from "./setup.js";

// The parts are exported as `plate` and `lid`: a part's body is its export
// binding (PartIdentity), its name only a label.
const PLATE_WIDTH = ParamKey.of("plate", "Width");
const LID_WIDTH = ParamKey.of("lid", "Width");
const PLATE_DEPTH = ParamKey.of("plate", "Depth");

function freshRegistry(overrides?: Record<string, ParamVal>, baselines?: Record<string, ParamVal>, active?: string): ParamRegistry {
  const registry = createParamRegistry();
  if (overrides) {
    registry.setOverrides(new Map(Object.entries(overrides)), baselines ? new Map(Object.entries(baselines)) : undefined);
  }
  if (active !== undefined) {
    registry.setActiveConfiguration(active);
  }
  return registry;
}

/** Two parts that both declare `Width` (and only Plate a `Depth`), optionally each with a table. */
function plateAndLid(
  seen: Record<string, unknown>,
  tables: { plate?: Record<string, Record<string, ParamVal>>; lid?: Record<string, Record<string, ParamVal>> } = {},
): void {
  const plate = part("Plate", () => {
    if (tables.plate) {
      configurations(tables.plate);
    }
    seen.plate = param("Width", 100);
    seen.depth = param("Depth", 5);
  });
  const lid = part("Lid", () => {
    if (tables.lid) {
      configurations(tables.lid);
    }
    seen.lid = param("Width", 40);
  });
  PartDefinition.bindExports({ plate, lid });
  getCurrentScene().materializeLeftoverDefinitions();
}

const widths = (registry: ParamRegistry): ParamDefinition[] =>
  registry.getDefinitions().filter(d => d.label === "Width");

describe("ParamKey", () => {
  it("encodes a body's parameter as a pair and a bodiless one as its label", () => {
    expect(PLATE_WIDTH.id).toBe('["plate","Width"]');
    expect(ParamKey.of(null, "Width").id).toBe("Width");
    expect(ParamKey.parse(PLATE_WIDTH.id).equals(PLATE_WIDTH)).toBe(true);
    expect(ParamKey.parse("Width").labelOnly).toBe(true);
    expect(ParamKey.parse("Width").label).toBe("Width");
  });

  it("reads anything that is not a well-formed pair as a label", () => {
    for (const label of ['["Plate"', '["a","b","c"]', '["a",2]', '[1,2]']) {
      const key = ParamKey.parse(label);
      expect(key.labelOnly).toBe(true);
      expect(key.label).toBe(label);
    }
  });

  it("keys a definition by its body, a project parameter by its label", () => {
    expect(ParamKey.ofDefinition({ kind: "part", label: "Width", body: "plate", bodyName: "Plate" }).equals(PLATE_WIDTH)).toBe(true);
    expect(ParamKey.ofDefinition({ kind: "global", label: "Wall", body: "Plate" }).id).toBe("Wall");
  });

  it("resolves a label to the one body declaring it, keeps an undeclared label, refuses a shared one", () => {
    const holders = ParamKey.holdersOf([
      { kind: "part", label: "Width", body: "plate", bodyName: "Plate" },
      { kind: "part", label: "Width", body: "lid", bodyName: "Lid" },
      { kind: "part", label: "Depth", body: "plate", bodyName: "Plate" },
      { kind: "global", label: "Wall" },
    ]);
    const depth = ParamKey.resolveLabel("Depth", holders);
    expect("key" in depth && depth.key.equals(PLATE_DEPTH)).toBe(true);
    const later = ParamKey.resolveLabel("Height", holders);
    expect("key" in later && later.key.labelOnly).toBe(true);
    const wall = ParamKey.resolveLabel("Wall", holders);
    expect("key" in wall && wall.key.id).toBe("Wall");
    const width = ParamKey.resolveLabel("Width", holders);
    expect(width).toEqual({
      error: "Parameter 'Width' is declared by 'Plate' and 'Lid' — name the part (body) whose parameter to set.",
      bodies: ["plate", "lid"],
    });
  });
});

describe("ParamRegistry — the same label in two parts", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
    vi.restoreAllMocks();
  });

  it("registers one definition per part, each stamped with its body", () => {
    const registry = freshRegistry();
    const seen: Record<string, unknown> = {};
    plateAndLid(seen);
    expect(seen).toEqual({ plate: 100, depth: 5, lid: 40 });
    expect(widths(registry).map(d => [d.body, d.bodyName, d.currentValue])).toEqual([["plate", "Plate", 100], ["lid", "Lid", 40]]);
    expect(registry.getAuthoredDefaults()).toEqual(new Map<string, ParamVal>([
      [PLATE_WIDTH.id, 100], [PLATE_DEPTH.id, 5], [LID_WIDTH.id, 40],
    ]));
  });

  it("applies a keyed override to its own part only", () => {
    const registry = freshRegistry({ [LID_WIDTH.id]: 55 });
    const seen: Record<string, unknown> = {};
    plateAndLid(seen);
    expect(seen).toEqual({ plate: 100, depth: 5, lid: 55 });
    expect(widths(registry).map(d => d.currentValue)).toEqual([100, 55]);
    expect(registry.getLabelOverrideUse().size).toBe(0);
  });

  it("discards one part's override when its literal changes, keeping the other's", () => {
    const registry = freshRegistry(
      { [PLATE_WIDTH.id]: 120, [LID_WIDTH.id]: 55 },
      { [PLATE_WIDTH.id]: 90, [LID_WIDTH.id]: 40 },
    );
    const seen: Record<string, unknown> = {};
    plateAndLid(seen);
    expect(seen).toEqual({ plate: 100, depth: 5, lid: 55 });
    expect(registry.getDiscardedOverrides()).toEqual([PLATE_WIDTH.id]);
  });

  it("gives each part its own configured value from its own table", () => {
    const registry = freshRegistry(undefined, undefined, "Wide");
    const seen: Record<string, unknown> = {};
    plateAndLid(seen, { plate: { Wide: { Width: 200 } }, lid: { Wide: { Width: 80 } } });
    expect(seen).toEqual({ plate: 200, depth: 5, lid: 80 });
    expect(widths(registry).map(d => [d.body, d.configuredValue, d.currentValue])).toEqual([
      ["plate", 200, 200], ["lid", 80, 80],
    ]);
  });

  it("reads a label-only override as the one part declaring the label", () => {
    const registry = freshRegistry({ Depth: 9 }, { Depth: 5 });
    const seen: Record<string, unknown> = {};
    plateAndLid(seen);
    expect(seen.depth).toBe(9);
    expect(registry.getLabelOverrideUse()).toEqual(new Map([["Depth", [PLATE_DEPTH.id]]]));
  });

  it("applies a label-only override to every part declaring the label, and reports each", () => {
    const registry = freshRegistry({ Width: 70 });
    const seen: Record<string, unknown> = {};
    plateAndLid(seen);
    expect(seen).toEqual({ plate: 70, depth: 5, lid: 70 });
    expect(registry.getLabelOverrideUse()).toEqual(new Map([["Width", [PLATE_WIDTH.id, LID_WIDTH.id]]]));
  });

  it("keys a top-level parameter by its label alone", () => {
    const registry = new ParamRegistry();
    registry.setOverrides(new Map([["width", 250]]));
    expect(registry.resolve("width", 300)).toBe(250);
    expect(registry.getAuthoredDefaults()).toEqual(new Map([["width", 300]]));
    expect(registry.getLabelOverrideUse().size).toBe(0);
  });
});

describe("SessionParamOverrides", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
    vi.restoreAllMocks();
  });

  /** One render pass of the two-part file with `session`'s overrides, settled. */
  function renderWith(session: SessionParamOverrides, plateWidth = 100): { seen: Record<string, unknown>; registry: ParamRegistry } {
    const registry = createParamRegistry();
    session.install(registry);
    const seen: Record<string, unknown> = {};
    const plate = part("Plate", () => {
      seen.plate = param("Width", plateWidth);
      seen.depth = param("Depth", 5);
    });
    const lid = part("Lid", () => {
      seen.lid = param("Width", 40);
    });
    PartDefinition.bindExports({ plate, lid });
    getCurrentScene().materializeLeftoverDefinitions();
    session.settle(registry);
    return { seen, registry };
  }

  const keyOf = (session: SessionParamOverrides, label: string, body?: string): ParamKey => {
    const resolved = session.keyFor(label, body);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    return resolved.key;
  };

  it("sets one part's Width without touching the other's", () => {
    const session = new SessionParamOverrides();
    renderWith(session);
    session.set(keyOf(session, "Width", "lid"), 55);
    expect(renderWith(session).seen).toEqual({ plate: 100, depth: 5, lid: 55 });
    expect(session.entries().map(e => [e.key.id, e.value])).toEqual([[LID_WIDTH.id, 55]]);
  });

  it("resolves a label-only set to the one part declaring it, and refuses a shared label", () => {
    const session = new SessionParamOverrides();
    renderWith(session);
    expect(keyOf(session, "Depth").equals(PLATE_DEPTH)).toBe(true);
    expect(session.keyFor("Width")).toEqual({
      error: "Parameter 'Width' is declared by 'Plate' and 'Lid' — name the part (body) whose parameter to set.",
      bodies: ["plate", "lid"],
    });
  });

  it("keeps a label set before any render label-only, then gives it to the one part declaring it", () => {
    const session = new SessionParamOverrides();
    session.set(keyOf(session, "Depth"), 8);
    expect(session.entries()[0].key.labelOnly).toBe(true);
    expect(renderWith(session).seen.depth).toBe(8);
    expect(session.entries().map(e => [e.key.id, e.value])).toEqual([[PLATE_DEPTH.id, 8]]);
    expect(session.toRecord()).toEqual({ Depth: 8 });
  });

  it("splits an old label-only entry two parts read into one entry per part, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new SessionParamOverrides();
    session.restore({ Width: 70 });
    expect(renderWith(session).seen).toEqual({ plate: 70, depth: 5, lid: 70 });
    expect(session.entries().map(e => [e.key.id, e.value])).toEqual([[PLATE_WIDTH.id, 70], [LID_WIDTH.id, 70]]);
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      "Parameter override 'Width' names no part, and 'Plate', 'Lid' all declare it — it was applied to each. Each part's 'Width' is now set on its own.",
    ]);
    // From here each part is its own: setting the Lid leaves the Plate's.
    session.set(LID_WIDTH, 30);
    expect(renderWith(session).seen).toEqual({ plate: 70, depth: 5, lid: 30 });
  });

  it("drops a re-authored part's override — a label-only one included — and keeps the other part's", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new SessionParamOverrides();
    renderWith(session);
    session.restore({ Width: 70 });
    // Before the split: the label-only entry stands for both parts.
    expect(renderWith(session, 120).seen).toEqual({ plate: 120, depth: 5, lid: 70 });
    expect(session.entries().map(e => [e.key.id, e.value])).toEqual([[LID_WIDTH.id, 70]]);
    expect(renderWith(session, 120).seen).toEqual({ plate: 120, depth: 5, lid: 70 });
  });

  it("names an override by its label while one part has it, by its key once two do", () => {
    const session = new SessionParamOverrides();
    renderWith(session);
    session.set(PLATE_DEPTH, 7);
    session.set(LID_WIDTH, 50);
    expect(session.toRecord()).toEqual({ Depth: 7, [LID_WIDTH.id]: 50 });

    // The record reads back to the same keys.
    const copy = new SessionParamOverrides();
    renderWith(copy);
    copy.restore(session.toRecord());
    expect(copy.entries().map(e => e.key.id).sort()).toEqual([LID_WIDTH.id, PLATE_DEPTH.id].sort());
  });

  it("names a single-part session's overrides by label, as before keys had a body", () => {
    const session = new SessionParamOverrides();
    const registry = createParamRegistry();
    const plate = part("Plate", () => {
      param("Width", 100);
    });
    PartDefinition.bindExports({ plate });
    getCurrentScene().materializeLeftoverDefinitions();
    session.settle(registry);
    session.set(keyOf(session, "Width"), 120);
    expect(session.entries()[0].key.equals(PLATE_WIDTH)).toBe(true);
    expect(session.toRecord()).toEqual({ Width: 120 });
  });

  it("renames and forgets one part's parameter only", () => {
    const session = new SessionParamOverrides();
    renderWith(session);
    session.set(PLATE_WIDTH, 120);
    session.set(LID_WIDTH, 50);
    session.rename(PLATE_WIDTH, "Breadth");
    expect(session.entries().map(e => [e.key.id, e.value])).toEqual([
      [LID_WIDTH.id, 50], [ParamKey.of("plate", "Breadth").id, 120],
    ]);
    session.forget(LID_WIDTH);
    expect(session.entries().map(e => e.key.id)).toEqual([ParamKey.of("plate", "Breadth").id]);
  });
});

describe("BrowserEngineHost — the same label in two parts", () => {
  const host = new BrowserEngineHost();
  const evaluator = async () => {
    const plate = part("Plate", () => {
      const width = param("Width", 100);
      sketch("xy", () => { testRect(width, 20); });
      extrude(10);
    });
    const lid = part("Lid", () => {
      const width = param("Width", 40);
      sketch("xy", () => { testRect(width, 20); });
      extrude(2);
    });
    return { plate, lid };
  };
  const widthOf = (outcome: { params?: ParamDefinition[] }, body: string) =>
    outcome.params?.find(p => p.label === "Width" && p.body === body)?.currentValue;

  it("sets the named part's parameter and refuses an ambiguous label", async () => {
    await host.init();
    host.setWorkspace({ "pair.part.js": "unused-by-this-evaluator" }, "pair.part.js");
    host.setModuleEvaluator(evaluator);
    let outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(outcome.params?.filter(p => p.label === "Width").map(p => p.body)).toEqual(["plate", "lid"]);

    outcome = await host.setParam("Width", 60, "lid");
    expect(widthOf(outcome, "plate")).toBe(100);
    expect(widthOf(outcome, "lid")).toBe(60);
    // A part named the way keys named it before bodies had an identity.
    outcome = await host.setParam("Width", 65, "Lid");
    expect(widthOf(outcome, "lid")).toBe(65);

    await expect(host.setParam("Width", 10)).rejects.toThrow("Parameter 'Width' is declared by 'Plate' and 'Lid'");
    outcome = await host.resetParams();
    expect(widthOf(outcome, "lid")).toBe(40);
    host.unloadModel();
  });
});
