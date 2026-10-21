// Two part() bodies of one file with the SAME name are two parts: each
// body's parameters, session overrides, configured values and table are
// filed under its hidden identity (PartIdentity) — its export binding, else
// its name and order (`Plate#2`) — and the name is only its label.

import { describe, it, expect, afterEach, vi } from "vitest";
import param from "../core/param.js";
import part from "../core/part.js";
import configurations from "../core/configurations.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { testRect } from "./helpers/profiles.js";
import { getCurrentScene } from "../scene-manager.js";
import { BrowserEngineHost } from "../browser/index.js";
import { createParamRegistry, type ParamDefinition, type ParamRegistry, type ParamVal } from "../param-registry.js";
import { ParamKey } from "../param-key.js";
import { SessionParamOverrides } from "../session-param-overrides.js";
import { PartDefinition } from "../features/part-definition.js";
import { PartIdentity } from "../features/part-identity.js";
import { Part } from "../features/part.js";
import { setupOC } from "./setup.js";

type Tables = { plate?: Record<string, Record<string, ParamVal>>; lid?: Record<string, Record<string, ParamVal>> };

/** Two parts both named `Plate`, both declaring `Width`; `seen` collects the values their bodies read. */
function twoPlates(seen: Record<string, unknown>, tables: Tables = {}): { plate: PartDefinition; lid: PartDefinition } {
  const plate = part("Plate", () => {
    if (tables.plate) {
      configurations(tables.plate);
    }
    seen.plate = param("Width", 100);
  });
  const lid = part("Plate", () => {
    if (tables.lid) {
      configurations(tables.lid);
    }
    seen.lid = param("Width", 40);
  });
  return { plate, lid };
}

/** The module's exports bound, then the entry render's leftover pass. */
function renderExported(seen: Record<string, unknown>, tables: Tables = {}): { plate: PartDefinition; lid: PartDefinition } {
  const defs = twoPlates(seen, tables);
  PartDefinition.bindExports(defs);
  getCurrentScene().materializeLeftoverDefinitions();
  return defs;
}

const widths = (registry: ParamRegistry): ParamDefinition[] =>
  registry.getDefinitions().filter(d => d.label === "Width");

const PLATE = ParamKey.of("plate", "Width");
const LID = ParamKey.of("lid", "Width");

describe("PartIdentity", () => {
  it("is the binding, else the name and order", () => {
    const bound = new PartIdentity("Plate", 2);
    bound.bind("lid");
    expect(bound.id).toBe("lid");
    expect(new PartIdentity("Plate", 2).id).toBe("Plate#2");
  });

  it("takes the first of several bindings in code-unit order, whatever order they came in", () => {
    const a = new PartIdentity("Plate", 1);
    a.bind("top");
    a.bind("lid");
    const b = new PartIdentity("Plate", 1);
    b.bind("lid");
    b.bind("top");
    expect([a.id, b.id]).toEqual(["lid", "lid"]);
  });

  it("ignores `default` and is fixed by its first read", () => {
    const identity = new PartIdentity("Plate", 1);
    identity.bind("default");
    expect(identity.id).toBe("Plate#1");
    identity.bind("plate");
    expect(identity.id).toBe("Plate#1");
  });

  it("tags a body for display: the binding, or #n for a fallback", () => {
    expect(PartIdentity.tag("lid")).toBe("lid");
    expect(PartIdentity.tag("Plate#2")).toBe("#2");
    expect(PartIdentity.isFallback("Plate#2")).toBe(true);
    expect(PartIdentity.isFallback("lid")).toBe(false);
    expect(PartIdentity.label("Plate", "lid", true)).toBe("Plate (lid)");
    expect(PartIdentity.label("Plate", "Plate#2", true)).toBe("Plate (#2)");
    expect(PartIdentity.label("Plate", "lid", false)).toBe("Plate");
  });
});

describe("two parts of one name — the registry", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
    vi.restoreAllMocks();
  });

  it("files each exported part's parameter under its binding, named by the part's name", () => {
    const registry = createParamRegistry();
    const seen: Record<string, unknown> = {};
    renderExported(seen);
    expect(seen).toEqual({ plate: 100, lid: 40 });
    expect(widths(registry).map(d => [d.body, d.bodyName, d.currentValue])).toEqual([
      ["plate", "Plate", 100], ["lid", "Plate", 40],
    ]);
    expect(registry.getAuthoredDefaults()).toEqual(new Map<string, ParamVal>([[PLATE.id, 100], [LID.id, 40]]));
  });

  it("applies each part's override to that part only", () => {
    const registry = createParamRegistry();
    registry.setOverrides(new Map<string, unknown>([[LID.id, 55]]));
    const seen: Record<string, unknown> = {};
    renderExported(seen);
    expect(seen).toEqual({ plate: 100, lid: 55 });
  });

  it("gives each part its own configured value and its own table", () => {
    const registry = createParamRegistry();
    registry.setActiveConfiguration("Wide");
    const seen: Record<string, unknown> = {};
    renderExported(seen, { plate: { Wide: { Width: 200 } }, lid: { Wide: { Width: 80 } } });
    expect(seen).toEqual({ plate: 200, lid: 80 });
    expect(widths(registry).map(d => [d.body, d.configuredValue])).toEqual([["plate", 200], ["lid", 80]]);
    expect(registry.getConfigurationTables().map(t => [t.definition, t.name, t.rows.Wide.Width])).toEqual([
      ["plate", "Plate", 200], ["lid", "Plate", 80],
    ]);
    expect(registry.getConfigurationValues("lid")).toEqual(new Map<string, ParamVal>([["Width", 80]]));
  });

  it("falls back to the name and order for parts that are not exported", () => {
    const registry = createParamRegistry();
    registry.setOverrides(new Map<string, unknown>([[ParamKey.of("Plate#2", "Width").id, 33]]));
    const seen: Record<string, unknown> = {};
    twoPlates(seen);
    getCurrentScene().materializeLeftoverDefinitions();
    expect(seen).toEqual({ plate: 100, lid: 33 });
    expect(widths(registry).map(d => [d.body, d.bodyName])).toEqual([["Plate#1", "Plate"], ["Plate#2", "Plate"]]);
  });

  it("numbers parts per name: another name starts at 1", () => {
    createParamRegistry();
    const a = part("Plate", () => {});
    const b = part("Lid", () => {});
    const c = part("Plate", () => {});
    expect([a.getBodyId(), b.getBodyId(), c.getBodyId()]).toEqual(["Plate#1", "Lid#1", "Plate#2"]);
  });

  it("gives a body the same identity whether the host's loop, another body's read or the leftover pass builds it", () => {
    /** Two exported Plates, the lid's body reading the plate's exposures when `reads`; `build` runs after the binding. */
    const ids = (reads: boolean, build: (plate: PartDefinition, lid: PartDefinition) => void): (string | undefined)[] => {
      const registry = createParamRegistry();
      const plate: PartDefinition = part("Plate", () => {
        param("Width", 100);
      });
      const lid: PartDefinition = part("Plate", () => {
        if (reads) {
          void plate.features;
        }
        param("Width", 40);
      });
      PartDefinition.bindExports({ plate, lid });
      build(plate, lid);
      getCurrentScene().materializeLeftoverDefinitions();
      return widths(registry).map(d => d.body);
    };
    // The host materializes each export in turn.
    const loop = ids(false, (plate, lid) => {
      plate.materializeInto(getCurrentScene());
      lid.materializeInto(getCurrentScene());
    });
    // The lid builds first and its body reads the plate: the plate builds on demand.
    const onDemand = ids(true, (_plate, lid) => {
      lid.materializeInto(getCurrentScene());
    });
    // Nothing builds until the leftover pass.
    const leftover = ids(false, () => {});
    expect(loop).toEqual(["plate", "lid"]);
    expect(onDemand).toEqual(["plate", "lid"]);
    expect(leftover).toEqual(["plate", "lid"]);
  });

  it("keeps the fallback for a body built before the host bound its export, for every variant of the render", () => {
    createParamRegistry();
    const seen: Record<string, unknown> = {};
    const { plate, lid } = twoPlates(seen);
    // Built while the module still evaluates — a top-level read.
    const early = lid.materializeInto(getCurrentScene());
    PartDefinition.bindExports({ plate, lid });
    expect(lid.getBodyId()).toBe("Plate#2");
    expect(plate.getBodyId()).toBe("plate");
    expect(early.getBodyId()).toBe("Plate#2");
  });

  it("stamps the identity on the built part and its payload", () => {
    createParamRegistry();
    const { plate, lid } = renderExported({});
    const built = getCurrentScene().getAllSceneObjects().filter((o): o is Part => o instanceof Part);
    expect(built.map(p => [p.partName, p.getBodyId(), p.serialize().bodyId])).toEqual([
      ["Plate", "plate", "plate"], ["Plate", "lid", "lid"],
    ]);
    expect([plate.getBodyId(), lid.getBodyId()]).toEqual(["plate", "lid"]);
  });
});

describe("two parts of one name — references by name", () => {
  const holders = ParamKey.holdersOf([
    { kind: "part", label: "Width", body: "plate", bodyName: "Plate" },
    { kind: "part", label: "Width", body: "lid", bodyName: "Plate" },
    { kind: "part", label: "Depth", body: "plate", bodyName: "Plate" },
    { kind: "part", label: "Height", body: "box", bodyName: "Box" },
  ]);

  it("reads a body by its identity, or by the name of the one part so named", () => {
    const byId = ParamKey.resolveBody("lid", "Width", holders);
    expect("key" in byId && byId.key.id).toBe(LID.id);
    const byName = ParamKey.resolveBody("Plate", "Depth", holders);
    expect("key" in byName && byName.key.id).toBe(ParamKey.of("plate", "Depth").id);
    const old = ParamKey.resolveBody("Box", "Height", holders);
    expect("key" in old && old.key.id).toBe(ParamKey.of("box", "Height").id);
    const unknown = ParamKey.resolveBody("Gear", "Teeth", holders);
    expect("key" in unknown && unknown.key.id).toBe(ParamKey.of("Gear", "Teeth").id);
  });

  it("refuses a name two parts declaring the label share", () => {
    expect(ParamKey.resolveBody("Plate", "Width", holders)).toEqual({
      error: "'Plate' names 2 parts that declare 'Width' — 'Plate (plate)' and 'Plate (lid)'. "
        + 'Key the parameter by its part\'s id: ["plate","Width"] or ["lid","Width"].',
      bodies: ["plate", "lid"],
    });
  });

  it("names same-named parts apart in a shared-label refusal", () => {
    expect(ParamKey.resolveLabel("Width", holders)).toEqual({
      error: "Parameter 'Width' is declared by 'Plate (plate)' and 'Plate (lid)' — name the part (body) whose parameter to set.",
      bodies: ["plate", "lid"],
    });
  });
});

describe("two parts of one name — SessionParamOverrides", () => {
  setupOC();
  afterEach(() => {
    createParamRegistry();
    vi.restoreAllMocks();
  });

  function renderWith(session: SessionParamOverrides): Record<string, unknown> {
    const registry = createParamRegistry();
    session.install(registry);
    const seen: Record<string, unknown> = {};
    renderExported(seen);
    session.settle(registry);
    return seen;
  }

  it("sets each part's Width on its own and records them apart", () => {
    const session = new SessionParamOverrides();
    renderWith(session);
    const plate = session.keyFor("Width", "plate");
    const lid = session.keyFor("Width", "lid");
    if (!("key" in plate) || !("key" in lid)) {
      throw new Error("expected keys");
    }
    session.set(plate.key, 120);
    session.set(lid.key, 30);
    expect(renderWith(session)).toEqual({ plate: 120, lid: 30 });
    expect(session.toRecord()).toEqual({ [PLATE.id]: 120, [LID.id]: 30 });
  });

  it("refuses a set by the shared name", () => {
    const session = new SessionParamOverrides();
    renderWith(session);
    const resolved = session.keyFor("Width", "Plate");
    expect("error" in resolved && resolved.error).toMatch(/^'Plate' names 2 parts that declare 'Width'/);
  });

  it("restores a record keyed by a unique part name, and refuses one keyed by a shared name", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new SessionParamOverrides();
    const registry = createParamRegistry();
    const box = part("Box", () => { param("Height", 10); });
    const plate = part("Plate", () => { param("Width", 100); });
    const lid = part("Plate", () => { param("Width", 40); });
    PartDefinition.bindExports({ box, plate, lid });
    getCurrentScene().materializeLeftoverDefinitions();
    session.settle(registry);

    const refusals = session.restore({ '["Box","Height"]': 12, '["Plate","Width"]': 70 });
    expect(session.entries().map(e => [e.key.id, e.value])).toEqual([[ParamKey.of("box", "Height").id, 12]]);
    expect(refusals).toEqual([expect.stringMatching(/^'Plate' names 2 parts that declare 'Width'/)]);
  });

  it("moves a name-keyed entry set before any render to the one part of that name, and drops a shared one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new SessionParamOverrides();
    session.restore({ '["Plate","Width"]': 70 });
    // The render cannot honour a name-keyed entry; settle resolves it.
    expect(renderWith(session)).toEqual({ plate: 100, lid: 40 });
    expect(session.entries()).toEqual([]);
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      expect.stringMatching(/^Parameter override \["Plate","Width"\] was dropped: 'Plate' names 2 parts/),
    ]);

    const single = new SessionParamOverrides();
    single.restore({ '["Box","Height"]': 12 });
    const registry = createParamRegistry();
    single.install(registry);
    const box = part("Box", () => { param("Height", 10); });
    PartDefinition.bindExports({ box });
    getCurrentScene().materializeLeftoverDefinitions();
    single.settle(registry);
    expect(single.entries().map(e => [e.key.id, e.value])).toEqual([[ParamKey.of("box", "Height").id, 12]]);
  });
});

describe("BrowserEngineHost — two parts of one name", () => {
  const host = new BrowserEngineHost();
  const evaluator = async () => {
    const plate = part("Plate", () => {
      configurations({ Wide: { Width: 200 } });
      const width = param("Width", 100);
      sketch("xy", () => { testRect(width, 20); });
      extrude(10);
    });
    const lid = part("Plate", () => {
      const width = param("Width", 40);
      sketch("xy", () => { testRect(width, 20); });
      extrude(2);
    });
    return { plate, lid };
  };
  const bodies = (outcome: { params?: ParamDefinition[] }) =>
    outcome.params?.filter(p => p.label === "Width").map(p => [p.body, p.currentValue]);

  it("keeps the pair apart in every render, a configuration's included", async () => {
    await host.init();
    host.setWorkspace({ "pair.part.js": "unused-by-this-evaluator" }, "pair.part.js");
    host.setModuleEvaluator(evaluator);
    let outcome = await host.render();
    expect(outcome.compileError).toBeNull();
    expect(bodies(outcome)).toEqual([["plate", 100], ["lid", 40]]);

    outcome = await host.setParam("Width", 60, "lid");
    expect(bodies(outcome)).toEqual([["plate", 100], ["lid", 60]]);
    await expect(host.setParam("Width", 10, "Plate")).rejects.toThrow("'Plate' names 2 parts that declare 'Width'");

    outcome = await host.setConfiguration("Wide");
    expect(bodies(outcome)).toEqual([["plate", 200], ["lid", 60]]);
    const rows = outcome.result as { type: string; object?: { bodyId?: string } }[];
    const parts = rows.filter(o => o.type === "part").map(o => o.object?.bodyId);
    expect(parts).toEqual(["plate", "lid"]);
    host.unloadModel();
  });
});
