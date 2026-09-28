import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import part from "../core/part.js";
import param from "../core/param.js";
import property from "../core/property.js";
import insert from "../core/insert.js";
import { breakpoint } from "../core/breakpoint.js";
import { testRect } from "./helpers/profiles.js";
import { Part } from "../features/part.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";

function startAssembly(): AssemblyScene {
  return getSceneManager().startAssemblyScene() as AssemblyScene;
}

/** A parametric bushing publishing a derived length and a couple of plain values. */
function makeBushing() {
  return part("Bushing", () => {
    const width = param("Width", 40);
    const wall = param("Wall", 3);
    sketch("xy", () => { testRect(width, width); });
    extrude(10);
    property("internalWidth", width - 2 * wall, "length");
    property("boltCount", 4);
    property("finish", "anodised");
    property("holes", [6, 8], "length");
  });
}

describe("property() scope and validation", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("throws when called outside a part() block", () => {
    expect(() => property("width", 10)).toThrow(/inside a part\(\) block/i);
  });

  it("throws at assembly top level with the same pointed error", () => {
    startAssembly();
    expect(() => property("width", 10)).toThrow(/inside a part\(\) block/i);
  });

  it("is accepted inside a nested callback of the part body, like param()", () => {
    const def = part("nested", () => {
      sketch("xy", () => {
        testRect(20, 20);
        property("fromSketch", 1);
      });
      extrude(5);
    });
    expect(def.properties.fromSketch).toBe(1);
  });

  it("rejects a missing or non-identifier name", () => {
    for (const bad of ["", "internal width", "1st", "a-b"]) {
      expect(() => {
        part(`bad-name-${bad}`, () => { property(bad, 1); }).materialize();
      }).toThrow(/identifier/i);
    }
    expect(() => {
      part("no-name", () => { (property as unknown as (v: number) => void)(5); }).materialize();
    }).toThrow(/name/i);
  });

  it("throws on a duplicate name within the same part", () => {
    expect(() => {
      part("dup", () => {
        property("w", 1);
        property("w", 2);
      }).materialize();
    }).toThrow(/already declares "w"/i);
  });

  it("allows the same name in two different parts", () => {
    const a = part("same-a", () => { property("w", 1); });
    const b = part("same-b", () => { property("w", 2); });
    expect(a.properties.w).toBe(1);
    expect(b.properties.w).toBe(2);
  });

  it("refuses geometry with a pointer to expose()", () => {
    expect(() => {
      part("geometry", () => {
        const s = sketch("xy", () => { testRect(20, 20); });
        property("profile", s as any);
      }).materialize();
    }).toThrow(/expose\('profile', source\)/);
  });

  it("refuses values that are not primitives or arrays of them", () => {
    for (const bad of [{ x: 1 }, () => 5, null, undefined, [1, { y: 2 }]]) {
      expect(() => {
        part("bad-value", () => { property("v", bad as any); }).materialize();
      }).toThrow(/must be a number, string, boolean, or array/i);
    }
  });

  it("refuses an unknown kind and a non-numeric length", () => {
    expect(() => {
      part("bad-kind", () => { property("v", 1, "angle" as any); }).materialize();
    }).toThrow(/unknown kind "angle"/);
    expect(() => {
      part("text-length", () => { property("v", "10mm" as any, "length"); }).materialize();
    }).toThrow(/'length' property must be a finite number/);
    expect(() => {
      part("nan-length", () => { property("v", Number.NaN, "length"); }).materialize();
    }).toThrow(/'length' property must be a finite number/);
  });

  it("returns the value so the statement can declare a local", () => {
    let seen: number | undefined;
    part("returns", () => { seen = property("w", 12); }).materialize();
    expect(seen).toBe(12);
  });

  it("records the declaration with its kind and source location on the variant", () => {
    const def = part("recorded", () => {
      property("w", 12, "length");
      property("n", 3);
    });
    const declared = def.getProperties();
    expect(declared.map(p => [p.name, p.value, p.kind])).toEqual([["w", 12, "length"], ["n", 3, undefined]]);
    // Only `.fluid.js`-style frames stamp a location — a plain test module has none.
    expect(declared[0].sourceLocation).toBeUndefined();
  });
});

describe("reading properties", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("def.properties serves the default variant's values", () => {
    const def = makeBushing();
    expect(def.properties.internalWidth).toBe(34);
    expect(def.properties.boltCount).toBe(4);
    expect(def.properties.finish).toBe("anodised");
    expect(def.properties.holes).toEqual([6, 8]);
  });

  it("instance.properties serves each variant's own values", () => {
    const def = makeBushing();
    startAssembly();
    const plain = insert(def);
    const wide = insert(def, { Width: 60 });
    const thin = insert(def, { Width: 60, Wall: 1 });
    expect(plain.properties.internalWidth).toBe(34);
    expect(wide.properties.internalWidth).toBe(54);
    expect(thin.properties.internalWidth).toBe(58);
    expect(wide.properties.boltCount).toBe(4);
  });

  it("values feed other statements of the assembly directly", () => {
    const def = makeBushing();
    const plate = part("Plate", () => {
      const w = param("Width", 10);
      property("width", w);
    });
    startAssembly();
    const b = insert(def, { Width: 60 });
    const p = insert(plate, { Width: b.properties.internalWidth as number }).translate(b.properties.internalWidth as number, 0, 0);
    expect(p.properties.width).toBe(54);
    expect(p.record.position.x).toBe(54);
  });

  it("an undeclared name throws a pointed error listing the declared ones", () => {
    const def = makeBushing();
    startAssembly();
    const b = insert(def);
    expect(() => b.properties.internalWidht).toThrow(
      /part "Bushing" has no property "internalWidht" — declared properties: internalWidth, boltCount, finish, holes/,
    );
    const bare = part("bare", () => {});
    expect(() => bare.properties.anything).toThrow(/it declares none/);
  });

  it("stays a plain object for protocol probes and enumeration", () => {
    const def = makeBushing();
    expect(Object.keys(def.properties)).toEqual(["internalWidth", "boltCount", "finish", "holes"]);
    expect(JSON.stringify(def.properties)).toBe('{"internalWidth":34,"boltCount":4,"finish":"anodised","holes":[6,8]}');
    expect((def.properties as any).then).toBeUndefined();
  });

  it("is empty for a part that declares none", () => {
    const def = part("bare", () => {
      sketch("xy", () => { testRect(10, 10); });
      extrude(5);
    });
    startAssembly();
    expect(Object.keys(insert(def).properties)).toEqual([]);
    expect(def.getProperties()).toEqual([]);
  });

  it("re-throws the breakpoint when the variant paused before the declaration", () => {
    const def = part("paused", () => {
      property("before", 1);
      (breakpoint as unknown as () => void)();
      property("after", 2);
    });
    startAssembly();
    let handle: ReturnType<typeof insert> | undefined;
    try {
      handle = insert(def);
    } catch (e) {
      if (!(e instanceof BreakpointHit)) {
        throw e;
      }
    }
    expect(handle).toBeUndefined();
    // The partial variant is in the scene: statements before the pause registered.
    const variant = def.builtVariantsIn(getCurrentScene()!)[0];
    expect(variant.properties.before).toBe(1);
    expect(() => variant.properties.after).toThrow(BreakpointHit);
  });
});

describe("property units", () => {
  it("rescales 'length' properties into the consuming unit and leaves the rest verbatim", () => {
    const variant = new Part("inch-part");
    variant.setUnit("in");
    variant.setTargetUnit("mm");
    variant.addProperty({ name: "bore", value: 0.5, kind: "length" });
    variant.addProperty({ name: "holes", value: [1, 2], kind: "length" });
    variant.addProperty({ name: "count", value: 4 });
    variant.addProperty({ name: "label", value: "half inch" });
    expect(variant.properties.bore).toBeCloseTo(12.7);
    expect(variant.properties.holes).toEqual([25.4, 50.8]);
    expect(variant.properties.count).toBe(4);
    expect(variant.properties.label).toBe("half inch");
    // The declaration keeps the authored number.
    expect(variant.getProperties()[0].value).toBe(0.5);
  });

  it("is the identity when the units match", () => {
    const variant = new Part("mm-part");
    variant.setUnit("mm");
    variant.setTargetUnit("mm");
    variant.addProperty({ name: "bore", value: 12.5, kind: "length" });
    expect(variant.properties.bore).toBe(12.5);
  });
});

describe("property serialization", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("rides the serialized instance and the template payload, absent when none are declared", () => {
    const def = makeBushing();
    const bare = part("bare", () => {});
    const scene = startAssembly();
    const b = insert(def, { Width: 60 });
    insert(bare);
    const [bushing, plain] = scene.getSerializedInstances();
    expect(bushing.properties).toEqual({ internalWidth: 54, boltCount: 4, finish: "anodised", holes: [6, 8] });
    expect(plain.properties).toBeUndefined();
    expect(b.record.part.serialize().properties).toEqual(bushing.properties);
    expect("properties" in b.record.part.serialize()).toBe(true);
  });
});
