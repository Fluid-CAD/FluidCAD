// definePart(): a custom feature made an insertable part. The insert takes
// the feature's typed-in values by id; equal values share one template; the
// feature's frames are the part's connectors; a bad id or value is a build
// error on the insert's row (render() never throws — assert getError()); a
// feature that requires a pick is refused; and the definition carries a JSON
// schema snapshot for the editor.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { AssemblyCompare } from "../../rendering/assembly-compare.js";
import { Scene } from "../../rendering/scene.js";
import insert from "../../core/insert.js";
import mate from "../../core/mate.js";
import { Part } from "../../features/part.js";
import { PartDefinition } from "../../features/part-definition.js";
import { Connector } from "../../features/connector.js";
import { Instance } from "../../features/instance.js";
import { ShapeProps } from "../../oc/props.js";
import { Feature, definePart } from "../../sdk/index.js";
import { GeneratedSchemas } from "../../sdk/generated-schema.js";
import type { Shape } from "../../sdk/kernel.js";
import { defineSpur, spurRadius, SPUR_DEFAULTS } from "../fixtures/custom-features/spur.js";
import { defineGear } from "../fixtures/custom-features/gear.js";

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** The top-level part templates an assembly scene holds. */
function templates(scene: Scene): Part[] {
  return scene.getAllSceneObjects().filter((o): o is Part => o instanceof Part && o.getParent() === null);
}

function solidVolumes(part: Part): number[] {
  return part.getChildren()
    .flatMap(child => child.getShapes())
    .filter(shape => shape.isSolid())
    .map(shape => ShapeProps.getProperties(shape.getShape()).volumeMm3);
}

const near = (point: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(point.x).toBeCloseTo(x, 6);
  expect(point.y).toBeCloseTo(y, 6);
  expect(point.z).toBeCloseTo(z, 6);
};

function spurPart(meta: Record<string, unknown> = { label: 'Spur' }) {
  const { Spur } = defineSpur();
  return definePart(Spur, meta as never);
}

/** An assembly scene with `body` run in it, rendered. */
function assembly(body: () => void): AssemblyScene {
  const scene = getSceneManager().startAssemblyScene();
  body();
  getSceneManager().renderScene(scene);
  return scene;
}

/**
 * `code` run as an assembly file's statements, its frames attributed to
 * `/gears.assembly.js` (a `//# sourceURL`), so an insert's row has a line:
 * the first statement is line 1.
 */
function assemblyFile(code: string, scope: Record<string, unknown>): AssemblyScene {
  const scene = getSceneManager().startAssemblyScene();
  const names = Object.keys(scope);
  new Function(...names, `"use strict";\n${code}\n//# sourceURL=/gears.assembly.js`)(...names.map(name => scope[name]));
  getSceneManager().renderScene(scene);
  return scene;
}

describe("definePart", () => {
  setupOC();

  it("is a part definition, marked generated and keyed by its feature's id", () => {
    const def = spurPart();
    expect(def).toBeInstanceOf(PartDefinition);
    expect(def.getType()).toBe("part-definition");
    expect(def.generated).toEqual({ kind: "part", id: "acme.spur" });
    expect(def.partName).toBe("Spur");
    expect(GeneratedSchemas.isGenerated(def)).toBe(true);
  });

  it("inserts one instance from values by id, its axis connector on the frame the feature set", () => {
    const def = spurPart();
    let pinion: Instance<unknown> | null = null;
    const scene = assembly(() => {
      pinion = insert(def, { teeth: 18, width: 12 }) as Instance<unknown>;
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getInstances()).toHaveLength(1);
    const [template] = templates(scene);
    expect(template.partName).toBe("Spur");
    expect(template.paramValues).toEqual({ teeth: 18, module: SPUR_DEFAULTS.module, width: 12, style: SPUR_DEFAULTS.style });
    expect(template.generated).toEqual({ definition: "acme.spur", values: template.paramValues });
    // The disc is the feature built as a new solid with the insert's values.
    expect(solidVolumes(template)).toHaveLength(1);
    expect(solidVolumes(template)[0]).toBeCloseTo(Math.PI * spurRadius(18, SPUR_DEFAULTS.module) ** 2 * 12, 3);
    // The frame is a connector of its name, at the part's own origin.
    const axis = template.getNamedConnectors().axis;
    expect(axis).toBeInstanceOf(Connector);
    near(axis.getFrame().origin, 0, 0, 0);
    near(axis.getFrame().normal, 0, 0, 1);
    expect(Object.keys((pinion as unknown as Instance<unknown>).connectors)).toEqual(["axis"]);
  });

  it("mates on its frame's connector like any part's", () => {
    const def = spurPart();
    const scene = assembly(() => {
      const a = insert(def).grounded();
      const b = insert(def, { teeth: 40 });
      mate("fastened", a.connectors.axis, b.connectors.axis);
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getMates()).toHaveLength(1);
  });

  it("shares one template between inserts whose values are equal once defaults are filled", () => {
    const def = spurPart();
    const scene = assembly(() => {
      insert(def);
      insert(def, { teeth: SPUR_DEFAULTS.teeth });
      insert(def, { style: "spur", module: SPUR_DEFAULTS.module });
      insert(def, { teeth: 30 });
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getInstances()).toHaveLength(4);
    const parts = scene.getInstances().map(instance => instance.part);
    expect(new Set(parts).size).toBe(2);
    expect(parts[0]).toBe(parts[1]);
    expect(parts[0]).toBe(parts[2]);
    expect(parts[3].paramValues?.teeth).toBe(30);
  });

  it("keeps its part cached across renders while the values stand, and rebuilds it when one changes", () => {
    const build = (teeth: number) => {
      const scene = getSceneManager().startAssemblyScene();
      insert(spurPart(), { teeth });
      return scene;
    };
    const same = AssemblyCompare.compare(build(20), build(20));
    expect(same.isCached(templates(same)[0])).toBe(true);
    const changed = AssemblyCompare.compare(build(20), build(22));
    expect(changed.isCached(templates(changed)[0])).toBe(false);
  });

  it("reports a misspelled id, a picked value's id, a refused value and a configuration on the insert's row, and builds the rest", () => {
    const def = spurPart();
    const scene = assemblyFile([
      "insert(def, { teeth: 20 });",
      "insert(def, { teth: 20 });",
      "insert(def, { teeth: 2 });",
      "insert(def, { at: 1 });",
      "insert(def, 'Wide');",
    ].join("\n"), { insert, def });

    const refused = templates(scene).filter(part => part.getError() !== null)
      .map(part => ({ line: (part.getSourceLocation()?.line ?? 0) - 3, error: part.getError() }));
    expect(refused).toEqual([
      { line: 2, error: "part 'Spur': 'teth' is not one of its values — did you mean 'teeth'? its values are teeth, module, width, style" },
      { line: 3, error: "part 'Spur': 'teeth' must be at least 4, got 2" },
      { line: 4, error: "part 'Spur': 'at' is a picked value of the feature — a generated part takes its typed-in values only, and leaves the picked ones out" },
      { line: 5, error: "part 'Spur': 'Wide' names a configuration, and a generated part has none — insert it with its values, such as insert(def, { … })" },
    ]);
    // The good insert built; a refused insert is an empty part.
    const built = templates(scene).filter(part => part.getError() === null);
    expect(built).toHaveLength(1);
    expect(solidVolumes(built[0])).toHaveLength(1);
    expect(scene.getInstances()).toHaveLength(5);
  });

  it("renders its default variant when its own file renders", () => {
    spurPart();
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const [template] = templates(scene);
    expect(template.paramValues).toEqual({ ...SPUR_DEFAULTS });
    expect(Object.keys(template.getNamedConnectors())).toEqual(["axis"]);
    expect(solidVolumes(template)[0]).toBeCloseTo(Math.PI * spurRadius(SPUR_DEFAULTS.teeth, SPUR_DEFAULTS.module) ** 2 * SPUR_DEFAULTS.width, 3);
  });

  it("renders one empty part saying so when a value has no default, however often its file materializes it", () => {
    class Post extends Feature.with({ height: { type: 'length', min: 1 } }) {
      static id = 'acme.post';
      buildTool(): Shape[] {
        return [];
      }
    }
    const def = definePart(Post, { label: "Post" });
    const scene = render();
    expect(def.materializeInto(scene)).toBe(def.materializeInto(scene));

    expect(templates(scene).map(part => part.getError())).toEqual(["part 'Post': 'height' is required"]);
  });

  it("names the part by meta.name when given, its label otherwise", () => {
    expect(spurPart({ label: "Spur gear", name: "Pinion" }).partName).toBe("Pinion");
  });

  it("builds a feature whose metadata offers 'add' but not 'new' as a solid of its own", () => {
    const { Spur } = defineSpur({ registered: false });
    Feature.register(Spur, { label: "Spur", operations: ['add'], defaultOperation: 'add' });
    const scene = assembly(() => {
      insert(definePart(Spur, { label: "Spur" }));
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(templates(scene)[0])).toHaveLength(1);
  });
});

describe("definePart refuses", () => {
  setupOC();

  it("a feature that requires a picked value, naming it", () => {
    const { Gear } = defineGear();
    expect(() => definePart(Gear as never, { label: "Gear" }))
      .toThrow("definePart(Gear): 'face' is a picked value the feature requires — a generated part takes typed-in values only, so each picked value must be optional (optional: true); the part leaves it out");
  });

  it("anything but a Feature tool that declares its values", () => {
    expect(() => definePart((() => {}) as never, { label: "X" }))
      .toThrow("definePart(): the first argument is the feature's class, one that extends Feature.with({ … }), got a function");
    class Modifier extends Feature.with({ r: { type: 'length', default: 1 } }) {
      static id = 'acme.modifier';
      override build(): void {}
    }
    expect(() => definePart(Modifier as never, { label: "M" }))
      .toThrow("definePart(Modifier): Modifier overrides build() — it changes solids it is handed, so it makes no part on its own; a generated part runs a tool, one that implements buildTool()");
  });

  it("a feature that only removes material", () => {
    const { Spur } = defineSpur({ registered: false });
    Feature.register(Spur, { label: "Pocket", operations: ['remove'], defaultOperation: 'remove' });
    expect(() => definePart(Spur, { label: "Spur" }))
      .toThrow("definePart(Spur): the feature only offers 'remove' — a generated part builds it as a solid of its own, so it must offer 'new' or 'add'");
  });

  it("bad metadata, naming the field", () => {
    const { Spur } = defineSpur();
    expect(() => definePart(Spur, {} as never)).toThrow("definePart(Spur): 'label' must be a non-empty string, got nothing");
    expect(() => definePart(Spur, { label: "Spur", call: [] } as never))
      .toThrow("definePart(Spur): leave 'call' out — a generated definition is inserted, not called: insert(def, { … }) takes its values by id");
    expect(() => definePart(Spur, { label: "Spur", group: "create" } as never))
      .toThrow("definePart(Spur): unknown field 'group' — the fields are label, description, icon, layout, name");
    expect(() => definePart(Spur, { label: "Spur", icon: "/abs/spur.svg" }))
      .toThrow("definePart(Spur): 'icon' must be a relative path from the module, such as './icon.svg' or '../features/icons/icon.svg', got '/abs/spur.svg'");
    expect(() => definePart(Spur, { label: "Spur", layout: ["at", "teeth", "module", "width", "style"] as never }))
      .toThrow("definePart(Spur): layout: names 'at', which is not one of the feature's values");
    expect(() => definePart(Spur, { label: "Spur", layout: ["teeth", "module", "width"] as never }))
      .toThrow("definePart(Spur): the value 'style' has no place in the layout");
  });
});

describe("a generated part's schema", () => {
  setupOC();

  it("lists the typed-in values by id, borrows the feature dialog less its pick, and names the connectors", () => {
    const schema = spurPart({ label: "Spur", description: "A spur gear", icon: "../features/icons/spur.svg" }).getSchema();

    expect(schema).toEqual({
      kind: "part",
      definitionKind: "generated",
      id: "acme.spur",
      label: "Spur",
      description: "A spur gear",
      icon: "../features/icons/spur.svg",
      params: {
        teeth: { type: "integer", default: 24, min: 4, max: 400, description: "The number of teeth round the gear", label: "Teeth" },
        module: { type: "length", default: 2, min: 0.1, description: "The tooth size", label: "Module" },
        width: { type: "length", default: 10, min: 0.01, label: "Face width" },
        style: {
          type: "select", default: "spur", label: "Style", display: "grid", columns: 2,
          options: [
            { label: "Spur", value: "spur", image: "./img/spur.png" },
            { label: "Helical", value: "helical", image: "./img/helical.png" },
          ],
        },
      },
      // The Placement section held only the pick (and a note about it): it
      // goes. The note that names the pick stays, read as nothing picked.
      layout: [
        { note: "Standing at the origin", visibleWhen: { at: { picked: false } } },
        { section: "Size", items: [{ row: ["teeth", "module"] }, "width"] },
        "style",
      ],
      width: "wide",
      aside: [{ image: "./img/spur-dims.svg", alt: "The spur gear" }],
      connectors: ["axis"],
      assetBase: { layout: "class" },
    });
    // Plain JSON, a fresh copy each time.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(GeneratedSchemas.assetsOf(schema)).toEqual({
      definition: ["../features/icons/spur.svg"],
      class: ["./img/spur.png", "./img/helical.png", "./img/spur-dims.svg"],
    });
  });

  it("takes the author's layout over the part's values, its images from the defining module", () => {
    const schema = spurPart({
      label: "Spur",
      layout: [{ section: "Gear", items: ["teeth", "module", "width"] }, { image: "./spur.svg" }, "style"],
    }).getSchema();

    expect(schema.layout).toEqual([{ section: "Gear", items: ["teeth", "module", "width"] }, { image: "./spur.svg" }, "style"]);
    expect(schema.assetBase).toEqual({ layout: "definition" });
    expect(GeneratedSchemas.assetsOf(schema).definition).toEqual(["./spur.svg"]);
  });

  it("derives the layout from the values when the feature registered no dialog", () => {
    const { Spur } = defineSpur({ registered: false });
    const schema = definePart(Spur, { label: "Spur" }).getSchema();
    expect(schema.layout).toEqual(["teeth", "module", "width", "style"]);
    expect(schema.width).toBeUndefined();
    expect(schema.aside).toBeUndefined();
  });
});
