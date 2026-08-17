import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { createParamRegistry, getParamRegistry } from "../param-registry.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import param from "../core/param.js";
import assembly from "../core/assembly.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import translate from "../core/translate.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { PartDefinition } from "../features/part-definition.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { setupOC, render } from "./setup.js";

function blockDef(name = "block") {
  return part(name, () => {
    const size = param("Size", 20, "number", { min: 5 });
    sketch("xy", () => rect(size, size));
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
  });
}

describe("part() definitions", () => {
  setupOC();

  it("is lazy — the callback does not run until materialization", () => {
    let ran = 0;
    part("lazy", () => { ran++; });
    expect(ran).toBe(0);
    expect(getCurrentScene().getAllSceneObjects()).toHaveLength(0);
    render();
    expect(ran).toBe(1);
  });

  it("returns a PartDefinition, not a scene object", () => {
    const def = part("d", () => {});
    expect(def).toBeInstanceOf(PartDefinition);
    expect(def.getType()).toBe("part-definition");
    expect(getCurrentScene().getAllSceneObjects()).toHaveLength(0);
  });

  it("rejects a missing name or callback", () => {
    expect(() => part("" as any, () => {})).toThrow(/name/i);
    expect(() => part("x", null as any)).toThrow(/callback/i);
  });

  it("materializes leftover definitions at render in creation order", () => {
    const order: string[] = [];
    part("a", () => { order.push("a"); });
    part("b", () => { order.push("b"); });
    render();
    expect(order).toEqual(["a", "b"]);
    const parts = getCurrentScene().getAllSceneObjects().filter(o => o instanceof Part) as Part[];
    expect(parts.map(p => p.partName)).toEqual(["a", "b"]);
  });

  it("does not double-build an already referenced definition at render", () => {
    let ran = 0;
    const def = part("once", () => { ran++; });
    def.materialize();
    render();
    expect(ran).toBe(1);
  });

  it("exposes the callback's return value as features (auto-materializing)", () => {
    const def = part("feat", () => ({ tag: 42 }));
    expect(def.features.tag).toBe(42);
    const parts = getCurrentScene().getAllSceneObjects().filter(o => o instanceof Part);
    expect(parts).toHaveLength(1);
  });

  it("can be created without any scene (library modules)", () => {
    // No startScene here on purpose: definitions are inert values.
    const def = new PartDefinition("standalone", () => {});
    expect(def.getType()).toBe("part-definition");
  });

  it("coerces definitions passed as transform targets", () => {
    const def = part("moved", () => {
      sketch("xy", () => rect(10, 10));
      extrude(5);
    });
    translate(50, 0, 0, def as any);
    const scene = render();
    const parts = scene.getAllSceneObjects().filter(o => o instanceof Part);
    expect(parts).toHaveLength(1);
  });
});

describe("param() inside part definitions", () => {
  setupOC();

  it("registers globally when the file's own definition materializes at root", () => {
    createParamRegistry();
    blockDef();
    render();
    const defs = getParamRegistry().getDefinitions();
    expect(defs.map(d => d.label)).toContain("Size");
  });

  it("resolves panel overrides through the global registry at root", () => {
    const registry = createParamRegistry();
    registry.setOverrides(new Map([["Size", 40]]));
    let seen = 0;
    part("p", () => { seen = param("Size", 20); });
    render();
    expect(seen).toBe(40);
  });
});

describe("insert(def, overrides)", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  function startAssembly(): AssemblyScene {
    return getSceneManager().startAssemblyScene();
  }

  it("materializes on first insert and shares the template across repeats", () => {
    startAssembly();
    let ran = 0;
    const def = part("shared", () => { ran++; });
    const a = insert(def);
    const b = insert(def);
    expect(ran).toBe(1);
    expect(a.record.part).toBe(b.record.part);
  });

  it("builds one template per distinct override set, shared across equal ones", () => {
    startAssembly();
    let ran = 0;
    const def = part("variant", () => {
      ran++;
      param("Length", 100);
    });
    const short1 = insert(def, { Length: 50 });
    const short2 = insert(def, { Length: 50 });
    const long1 = insert(def, { Length: 200 });
    const plain = insert(def);
    expect(ran).toBe(3);
    expect(short1.record.part).toBe(short2.record.part);
    expect(short1.record.part).not.toBe(long1.record.part);
    expect(plain.record.part).not.toBe(long1.record.part);
  });

  it("resolves param() from the insert overrides", () => {
    startAssembly();
    let seen: number | null = null;
    const def = part("p", () => { seen = param("Length", 100); });
    insert(def, { Length: 250 });
    expect(seen).toBe(250);
  });

  it("coerces override values toward the declared default's type", () => {
    startAssembly();
    let seen: number | null = null;
    const def = part("p", () => { seen = param("Length", 100); });
    insert(def, { Length: "175" as any });
    expect(seen).toBe(175);
  });

  it("keeps inserted definitions' params out of the global registry", () => {
    createParamRegistry();
    startAssembly();
    const def = part("p", () => { param("Length", 100); });
    insert(def);
    insert(def, { Length: 50 });
    expect(getParamRegistry().getDefinitions()).toHaveLength(0);
  });

  it("records the variant's params and values on the template and instance", () => {
    const scene = startAssembly();
    const def = part("p", () => { param("Length", 100, "number", { min: 10 }); });
    const inst = insert(def, { Length: 60 });
    const partObj = inst.record.part;
    expect(partObj.params?.map(p => p.label)).toEqual(["Length"]);
    expect(partObj.paramValues).toEqual({ Length: 60 });
    const serialized = scene.getSerializedInstances();
    expect(serialized[0].paramValues).toEqual({ Length: 60 });
  });

  it("shares one template when the same values ride a shared args object", () => {
    startAssembly();
    let ran = 0;
    const def = part("p", () => { ran++; param("Length", 100); });
    const cfg = { Length: 200 };
    const a = insert(def, cfg);
    const b = insert(def, cfg);
    expect(ran).toBe(1);
    expect(a.record.part).toBe(b.record.part);
  });

  it("rejects invalid override values", () => {
    startAssembly();
    const def = part("p", () => {});
    expect(() => insert(def, { Length: {} as any })).toThrow(/parameter 'Length'/);
  });

  it("rejects overrides on an already-built Part", () => {
    startAssembly();
    const def = part("p", () => {});
    const built = def.materialize();
    expect(() => insert(built as any, { Length: 5 })).toThrow(/already built/);
  });

  it("binds named connectors per variant", () => {
    startAssembly();
    const def = blockDef();
    const inst = insert(def, { Size: 30 });
    expect(Object.keys(inst.connectors)).toEqual(["top"]);
  });
});

describe("definition reads in assembly scenes", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("keeps a features read's params out of the global registry", () => {
    createParamRegistry();
    getSceneManager().startAssemblyScene();
    const def = part("p", () => {
      param("Length", 100);
      return { tag: 42 };
    });
    expect(def.features.tag).toBe(42);
    expect(getParamRegistry().getDefinitions()).toHaveLength(0);
  });

  it("a features read and insert() share one scoped template", () => {
    getSceneManager().startAssemblyScene();
    let ran = 0;
    const def = part("p", () => {
      ran++;
      param("Length", 100);
    });
    void def.features;
    const inst = insert(def);
    expect(ran).toBe(1);
    expect(inst.record.part.params?.map(p => p.label)).toEqual(["Length"]);
  });

  it("insert() then a features read returns the inserted template", () => {
    getSceneManager().startAssemblyScene();
    const def = part("p", () => ({ tag: 7 }));
    const inst = insert(def);
    expect(def.features).toBe(inst.record.part.features);
    expect(def.features.tag).toBe(7);
  });

  it("part-scene reads keep panel semantics", () => {
    createParamRegistry();
    const def = part("p", () => {
      param("Size", 20);
    });
    void def.features;
    expect(getParamRegistry().getDefinitions().map(d => d.label)).toContain("Size");
  });
});

describe("unknown override warnings", () => {
  beforeEach(() => {
    getSceneManager().startScene();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns on override keys the build never resolved", () => {
    getSceneManager().startAssemblyScene();
    const def = part("p", () => { param("Length", 100); });
    insert(def, { Lenght: 50 } as any);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'Lenght'"));
  });

  it("stays silent when every key resolves", () => {
    getSceneManager().startAssemblyScene();
    const def = part("p", () => { param("Length", 100); });
    insert(def, { Length: 50 });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("assembly definition parameters", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("resolves param() from occurrence overrides, never the global registry", () => {
    createParamRegistry();
    getSceneManager().startAssemblyScene();
    const block = part("b", () => {});
    const seen: number[] = [];
    const def = assembly("sub", () => {
      seen.push(param("Width", 700) as number);
      insert(block);
    });
    insert(def, { Width: 900 });
    insert(def);
    expect(seen).toEqual([900, 700]);
    expect(getParamRegistry().getDefinitions()).toHaveLength(0);
  });

  it("registers globally when run at root (standalone entry)", () => {
    createParamRegistry();
    getSceneManager().startAssemblyScene();
    const block = part("b", () => {});
    const def = assembly("sub", () => {
      param("Width", 700);
      insert(block);
    });
    def.run();
    expect(getParamRegistry().getDefinitions().map(d => d.label)).toEqual(["Width"]);
  });

  it("passes assembly params down into part variants", () => {
    getSceneManager().startAssemblyScene();
    let partSaw: number | null = null;
    const block = part("b", () => { partSaw = param("Length", 100); });
    const def = assembly("sub", () => {
      const depth = param("Depth", 800) as number;
      insert(block, { Length: depth });
    });
    insert(def, { Depth: 450 });
    expect(partSaw).toBe(450);
  });

  it("records occurrence params and values on the record and its serialization", () => {
    const scene = getSceneManager().startAssemblyScene();
    const block = part("b", () => {});
    const def = assembly("sub", () => {
      param("Width", 700, "number", { min: 100 });
      insert(block);
    });
    const occ = insert(def, { Width: 900 });
    expect(occ.record.params?.map(p => p.label)).toEqual(["Width"]);
    expect(occ.record.paramValues).toEqual({ Width: 900 });
    const serialized = scene.getSerializedOccurrences();
    expect(serialized[0].paramValues).toEqual({ Width: 900 });
    expect(serialized[0].params?.[0]).toMatchObject({ label: "Width", currentValue: 900, min: 100 });
    expect(serialized[0].params?.[0]).not.toHaveProperty("sourceLocation");
  });

  it("serializes the variant's param metadata on the part template", () => {
    getSceneManager().startAssemblyScene();
    const def = part("p", () => { param("Length", 100, "number", { min: 10 }); });
    const inst = insert(def, { Length: 60 });
    const payload = inst.record.part.serialize();
    expect(payload.paramValues).toEqual({ Length: 60 });
    expect(payload.params?.[0]).toMatchObject({ label: "Length", defaultValue: 100, currentValue: 60, min: 10 });
    expect(payload.params?.[0]).not.toHaveProperty("sourceLocation");
  });

  it("top-scope-only resolution: a part's label never leaks from the assembly scope", () => {
    getSceneManager().startAssemblyScene();
    let partSaw: number | null = null;
    const block = part("b", () => { partSaw = param("Length", 100); });
    const def = assembly("sub", () => {
      insert(block);
    });
    // 'Length' targets the assembly scope; the part's own 'Length' must not see it.
    insert(def, { Length: 999 });
    expect(partSaw).toBe(100);
  });
});
