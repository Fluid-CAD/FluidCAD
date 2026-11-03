// defineAssembly(): a generator made an insertable sub-assembly. The insert
// takes the generator's values by id; layout(g) declares the parts, their
// joints and a relation in the occurrence's scope; equal templates share one
// part, built once; occurrence.parts is what the layout returned; a bad id
// or value and a throw from the layout are a build error on the insert's row,
// a throw from build one on that part's row (render() never throws — assert
// getError()); an inch generator in an mm assembly is converted; the cache
// pairs generated parts by their template's identity.

import { describe, it, expect, afterEach } from "vitest";
import { setupOC } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { AssemblyCompare } from "../../rendering/assembly-compare.js";
import { Scene } from "../../rendering/scene.js";
import insert from "../../core/insert.js";
import mate from "../../core/mate.js";
import replicate from "../../core/replicate.js";
import { Part } from "../../features/part.js";
import { Assembly } from "../../features/assembly.js";
import { Instance } from "../../features/instance.js";
import { Occurrence } from "../../features/occurrence.js";
import { ShapeProps } from "../../oc/props.js";
import { Generator, defineAssembly, definePart } from "../../sdk/index.js";
import { GeneratedSchemas } from "../../sdk/generated-schema.js";
import type { GeneratedAssemblyDefinition } from "../../sdk/define-assembly.js";
import type { Shape } from "../../sdk/kernel.js";
import { BOARD, CABINET_DEFAULTS, defineCabinet, drawerTravel } from "../fixtures/custom-features/cabinet.js";
import { defineSpur } from "../fixtures/custom-features/spur.js";

const IN = 25.4;
const INCH_FILE = "/ws/fixtures/cabinet.assembly.js";

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** The parts a generator made in `scene`, by type. */
function generatedParts(scene: Scene, type?: string): Part[] {
  return scene.getAllSceneObjects().filter((o): o is Part => o instanceof Part && !!o.generatedBy && (!type || o.generatedBy.type === type));
}

function solidVolume(part: Part): number {
  return part.getChildren()
    .flatMap(child => child.getShapes())
    .filter(shape => shape.isSolid())
    .reduce((sum, shape) => sum + ShapeProps.getProperties(shape.getShape()).volumeMm3, 0);
}

const near = (point: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(point.x).toBeCloseTo(x, 6);
  expect(point.y).toBeCloseTo(y, 6);
  expect(point.z).toBeCloseTo(z, 6);
};

function cabinetDef(variant: Parameters<typeof defineCabinet>[0] = {}) {
  const { Cabinet, builds } = defineCabinet(variant);
  // The fixture's class type says nothing of its layout's handles: read them untyped.
  return { def: defineAssembly(Cabinet, { label: "Cabinet" }) as GeneratedAssemblyDefinition<any>, builds, Cabinet };
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
 * `/kitchen.assembly.js` (a `//# sourceURL`), so an insert's row has a line:
 * the first statement is line 1.
 */
function assemblyFile(code: string, scope: Record<string, unknown>): AssemblyScene {
  const scene = getSceneManager().startAssemblyScene();
  const names = Object.keys(scope);
  new Function(...names, `"use strict";\n${code}\n//# sourceURL=/kitchen.assembly.js`)(...names.map(name => scope[name]));
  getSceneManager().renderScene(scene);
  return scene;
}

/** The refused parts of `scene`: each insert's line (1-based, as `assemblyFile` numbers them) and its error. */
function refusals(scene: Scene): { line: number; error: string | null }[] {
  return scene.getAllSceneObjects()
    .filter((o): o is Part => o instanceof Part && o.getRefusal() !== null)
    .map(part => ({ line: (part.getSourceLocation()?.line ?? 0) - 3, error: part.getError() }));
}

describe("defineAssembly", () => {
  setupOC();

  it("is an assembly definition, marked generated and keyed by its generator's id", () => {
    const { def } = cabinetDef();
    expect(def).toBeInstanceOf(Assembly);
    expect(def.getType()).toBe("assembly");
    expect(def.generated).toEqual({ kind: "assembly", id: "acme.cabinet" });
    expect(def.assemblyName).toBe("Cabinet");
    expect(GeneratedSchemas.isGenerated(def)).toBe(true);
  });

  it("inserts an occurrence: the carcass grounded, the doors on revolute joints, the drawers on sliders, with limits", () => {
    const { def, builds } = cabinetDef();
    let occ: Occurrence<any> | null = null;
    const scene = assembly(() => {
      occ = insert(def).grounded();
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(occ).toBeInstanceOf(Occurrence);
    const [record] = scene.getOccurrences();
    expect(record.generated).toEqual({ definition: "acme.cabinet", values: { ...CABINET_DEFAULTS } });

    const instances = scene.getInstances();
    expect(instances.map(i => i.name)).toEqual(["Carcass", "Left door", "Right door", "Drawer 1", "Drawer 2"]);
    expect(instances.every(i => i.owner === "asm-0")).toBe(true);
    expect(instances.map(i => i.grounded)).toEqual([true, false, false, false, false]);
    // Grounded in the occurrence's frame, which the insert grounded.
    expect(scene.getSerializedInstances().map(i => i.grounded)).toEqual([true, false, false, false, false]);

    const mates = scene.getMates();
    expect(mates.map(m => [m.owner, m.type, m.name, m.options?.limits])).toEqual([
      ["asm-0", "revolute", "Left door", [0, CABINET_DEFAULTS.hingeAngle]],
      ["asm-0", "revolute", "Right door", [-CABINET_DEFAULTS.hingeAngle, 0]],
      ["asm-0", "slider", "Drawer 1", [0, drawerTravel(CABINET_DEFAULTS.depth)]],
      ["asm-0", "slider", "Drawer 2", [0, drawerTravel(CABINET_DEFAULTS.depth)]],
    ]);
    // Each joint holds the connectors of its two parts.
    expect(mates[0].connectorA?.instanceId).toBe(instances[0].instanceId);
    expect(mates[0].connectorA?.connector.connectorName).toBe("leftHinge");
    expect(mates[0].connectorB?.instanceId).toBe(instances[1].instanceId);
    expect(mates[2].connectorA?.connector.connectorName).toBe("runner0");
    expect(mates[2].connectorB?.instanceId).toBe(instances[3].instanceId);

    // Three templates: the carcass, one door for both doors, one drawer for both drawers — each built once.
    expect(generatedParts(scene).map(p => p.partName)).toEqual(["carcass", "door", "drawer"]);
    expect(instances[1].part).toBe(instances[2].part);
    expect(instances[3].part).toBe(instances[4].part);
    expect(Object.fromEntries(builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });

    const { width, height, depth, drawers, drawerHeight } = CABINET_DEFAULTS;
    expect(solidVolume(generatedParts(scene, "carcass")[0])).toBeCloseTo(width * depth * height, 3);
    expect(solidVolume(generatedParts(scene, "door")[0])).toBeCloseTo((width / 2) * BOARD * (height - drawers * drawerHeight), 3);
    const hinge = instances[0].part.getNamedConnectors().leftHinge.getFrame();
    near(hinge.origin, 0, -BOARD, drawers * drawerHeight);
    near(hinge.normal, 0, 0, 1);
    near(hinge.xDirection, 1, 0, 0);
  });

  it("couples the doors with a relation inside the occurrence", () => {
    const { def } = cabinetDef();
    const scene = assembly(() => {
      insert(def);
    });

    expect(errorsOf(scene)).toEqual([]);
    const [doors] = scene.getRelations();
    expect(doors.owner).toBe("asm-0");
    expect(doors.type).toBe("gear");
    expect(doors.name).toBe("Doors together");
    expect(doors.ratio).toBe(1);
    expect(doors.reverse).toBe(true);
    expect([doors.mateA.name, doors.mateB.name]).toEqual(["Left door", "Right door"]);
    expect(scene.getSerializedRelations()[0]).toMatchObject({ relationId: "asm-0/rel-0", mateA: "asm-0/mate-0", mateB: "asm-0/mate-1" });
  });

  it("sets the starting poses the layout gave", () => {
    const { def } = cabinetDef();
    const scene = assembly(() => {
      insert(def);
    });

    const right = scene.getInstances()[2];
    expect(right.position).toEqual({ x: CABINET_DEFAULTS.width, y: -BOARD, z: CABINET_DEFAULTS.drawers * CABINET_DEFAULTS.drawerHeight });
    // 180° about Z.
    expect(Math.abs(right.quaternion.z)).toBeCloseTo(1, 9);
    expect(right.quaternion.w).toBeCloseTo(0, 9);
    const secondDrawer = scene.getInstances()[4];
    expect(secondDrawer.position).toEqual({ x: BOARD, y: 0, z: CABINET_DEFAULTS.drawerHeight });
  });

  it("gives each part its template's appearance and material, and marks it generated on the wire", () => {
    const { def } = cabinetDef();
    const scene = assembly(() => {
      insert(def, { finish: "walnut" });
    });

    const carcass = generatedParts(scene, "carcass")[0];
    expect(carcass.getAppearance()).toBe("walnut");
    expect(carcass.getMaterial()).toBe("plywood");
    expect(generatedParts(scene, "drawer")[0].getAppearance()).toBeNull();

    const data = getSceneManager().getAssemblyData(scene)!;
    expect(JSON.parse(JSON.stringify(data.occurrences[0].generated))).toEqual({
      definition: "acme.cabinet", values: { ...CABINET_DEFAULTS, finish: "walnut" },
    });
    expect(data.instances.map(i => i.generatedBy)).toEqual([
      { definition: "acme.cabinet", type: "carcass" },
      { definition: "acme.cabinet", type: "door" },
      { definition: "acme.cabinet", type: "door" },
      { definition: "acme.cabinet", type: "drawer" },
      { definition: "acme.cabinet", type: "drawer" },
    ]);
    expect(data.instances[0]).toMatchObject({ appearance: "walnut", material: "plywood", partName: "carcass", name: "Carcass" });
    expect(data.instances.every(i => i.generated === undefined)).toBe(true);
    expect(carcass.serialize().generatedBy).toEqual({ definition: "acme.cabinet", type: "carcass" });
  });

  it("serializes a definePart instance's definition and values", () => {
    const { Spur } = defineSpur();
    const gear = definePart(Spur, { label: "Spur" });
    const scene = assembly(() => {
      insert(gear, { teeth: 30 });
    });

    const [instance] = getSceneManager().getAssemblyData(scene)!.instances;
    expect(instance.generated).toEqual({ definition: "acme.spur", values: instance.paramValues });
    expect(instance.generated?.values.teeth).toBe(30);
    expect(instance.generatedBy).toBeUndefined();
  });

  it("shares templates across the occurrences of one definition — inserting it twice works", () => {
    const { def, builds } = cabinetDef();
    const scene = assembly(() => {
      insert(def);
      insert(def, { width: CABINET_DEFAULTS.width });
      insert(def, { width: 800 });
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getOccurrences().map(o => o.occurrenceId)).toEqual(["asm-0", "asm-1", "asm-2"]);
    expect(scene.getInstances()).toHaveLength(15);
    expect(scene.getInstances().filter(i => i.owner === "asm-1").map(i => i.instanceId))
      .toEqual(["asm-1/inst-0", "asm-1/inst-1", "asm-1/inst-2", "asm-1/inst-3", "asm-1/inst-4"]);
    expect(scene.getMates().filter(m => m.owner === "asm-1")).toHaveLength(4);
    expect(scene.getRelations().map(r => r.owner)).toEqual(["asm-0", "asm-1", "asm-2"]);
    // The first two share all three templates; the wider one has its own.
    const partsOf = (owner: string) => scene.getInstances().filter(i => i.owner === owner).map(i => i.part);
    expect(partsOf("asm-1")).toEqual(partsOf("asm-0"));
    expect(partsOf("asm-2").some(part => partsOf("asm-0").includes(part))).toBe(false);
    expect(generatedParts(scene)).toHaveLength(6);
    expect(Object.fromEntries(builds)).toEqual({ carcass: 2, door: 2, drawer: 2 });
    // Engine-owned: two parts named 'door' are no part-rule refusal.
    expect(generatedParts(scene, "door").map(p => p.getRefusal())).toEqual([null, null]);
  });

  it("exposes what the layout returned as occurrence.parts, which the inserting assembly mates to", () => {
    const { def } = cabinetDef();
    let left: Occurrence<any> | null = null;
    const scene = assembly(() => {
      left = insert(def).grounded();
      const right = insert(def);
      mate("fastened", left.parts.carcass.connectors.rightHinge, right.parts.carcass.connectors.leftHinge);
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(left!.parts.carcass).toBeInstanceOf(Instance);
    expect(left!.parts.doors.left.record.name).toBe("Left door");
    expect(left!.record.exports).toEqual([
      { path: ["carcass"], instanceId: "asm-0/inst-0" },
      { path: ["doors", "left"], instanceId: "asm-0/inst-1" },
      { path: ["doors", "right"], instanceId: "asm-0/inst-2" },
      { path: ["drawers", "0"], instanceId: "asm-0/inst-3" },
      { path: ["drawers", "1"], instanceId: "asm-0/inst-4" },
    ]);
    const root = scene.getMates().filter(m => m.owner === "");
    expect(root).toHaveLength(1);
    expect(root[0].connectorA?.instanceId).toBe("asm-0/inst-0");
    expect(root[0].connectorB?.instanceId).toBe("asm-1/inst-0");
  });

  it("re-runs its layout with the seed's values for a replicate() of an occurrence, sharing the seed's parts", () => {
    const { def, builds } = cabinetDef();
    let copy: Occurrence<any> | null = null;
    const scene = assembly(() => {
      const a = insert(def).grounded();
      const b = insert(def, { width: 800 });
      mate("fastened", a.parts.carcass.connectors.base, b.parts.carcass.connectors.base);
      [copy] = replicate(b, [a.parts.carcass.connectors.base], [[a.parts.carcass.connectors.leftHinge]]) as Occurrence<any>[];
    });

    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getOccurrences().map(o => o.occurrenceId)).toEqual(["asm-0", "asm-1", "asm-2"]);
    expect(copy!.record.generated).toEqual(scene.getOccurrences()[1].generated);
    expect(copy!.record.generated?.values.width).toBe(800);
    expect(scene.getInstances().filter(i => i.owner === "asm-2").map(i => i.part))
      .toEqual(scene.getInstances().filter(i => i.owner === "asm-1").map(i => i.part));
    expect(scene.getMates().filter(m => m.owner === "asm-2")).toHaveLength(4);
    expect(Object.fromEntries(builds)).toEqual({ carcass: 2, door: 2, drawer: 2 });
  });

  it("renders at the assembly's root, every value at its default, when its own file renders", () => {
    const { def } = cabinetDef();
    const scene = getSceneManager().startAssemblyScene();
    def.run();
    getSceneManager().renderScene(scene);

    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getOccurrences()).toHaveLength(0);
    expect(scene.getInstances().map(i => i.owner)).toEqual(["", "", "", "", ""]);
    expect(scene.getSerializedInstances()[0].grounded).toBe(true);
    expect(def.wasRun()).toBe(true);
  });
});

describe("a generated assembly in another unit", () => {
  setupOC();

  afterEach(() => {
    getSceneManager().projectUnit = "mm";
  });

  it("rescales an inch generator's parts and converts its connectors, poses and slider limits into an mm assembly", () => {
    getSceneManager().projectUnit = "mm";
    const scene = getSceneManager().startAssemblyScene();
    getUnitRegistry().declare(INCH_FILE, "in");
    const { Cabinet } = defineCabinet();
    const def = new Function("defineAssembly", "Cabinet", `return defineAssembly(Cabinet, { label: 'Cabinet' });\n//# sourceURL=${INCH_FILE}`)(
      defineAssembly, Cabinet,
    ) as ReturnType<typeof defineAssembly>;
    const values = { width: 24, height: 30, depth: 20, drawers: 1, drawerHeight: 6 };
    insert(def, values);
    getSceneManager().renderScene(scene);

    expect(errorsOf(scene)).toEqual([]);
    const carcass = generatedParts(scene, "carcass")[0];
    expect(carcass.getDefinitionUnit()).toBe("in");
    expect(carcass.getTargetUnit()).toBe("mm");
    expect(solidVolume(carcass)).toBeCloseTo(24 * 20 * 30 * IN ** 3, 0);
    near(carcass.getNamedConnectors().leftHinge.getFrame().origin, 0, -BOARD * IN, 6 * IN);
    // The values are the generator's numbers, recorded as given.
    expect(scene.getOccurrences()[0].generated?.values).toMatchObject(values);

    const [, , right, drawer] = scene.getInstances();
    expect(right.position.x).toBeCloseTo(24 * IN, 9);
    expect(right.position.y).toBeCloseTo(-BOARD * IN, 9);
    expect(right.position.z).toBeCloseTo(6 * IN, 9);
    expect(drawer.position.x).toBeCloseTo(BOARD * IN, 9);

    const [leftSwing, , slide] = scene.getMates();
    expect(leftSwing.options?.limits).toEqual([0, CABINET_DEFAULTS.hingeAngle]);
    expect(slide.options?.limits?.[1]).toBeCloseTo(drawerTravel(20) * IN, 9);
    // A gear ratio has no length in it.
    expect(scene.getRelations()[0].ratio).toBe(1);
  });

  it("converts an inch generator's mate offsets, rack ratio and translations, and leaves its angles", () => {
    getSceneManager().projectUnit = "mm";
    const scene = getSceneManager().startAssemblyScene();
    getUnitRegistry().declare(INCH_FILE, "in");
    const up = { origin: [0, 0, 0], z: [0, 0, 1] } as const;
    class RackDrive extends Generator.with({}) {
      static id = "acme.rack-drive";
      layout(g: Parameters<Generator["layout"]>[0]) {
        const base = g.part("base", { connectors: { axle: up, rail: up } }).grounded();
        const pinion = g.part("pinion", { connectors: { bore: up } });
        const rack = g.part("rack", { connectors: { slot: up } }).translate(1, 2, 3).rotate("z", 90);
        const turn = g.mate("revolute", base.connectors.axle, pinion.connectors.bore).offset(1, 0, 0).rotate(30).limits(-45, 45);
        const slide = g.mate("slider", base.connectors.rail, rack.connectors.slot).offset(0, 0, 2).limits(0, 10);
        g.relation("rack-and-pinion", turn, slide, 3);
      }
      static build(): Shape[] {
        return [];
      }
    }
    const def = new Function("defineAssembly", "RackDrive", `return defineAssembly(RackDrive, { label: 'Drive' });\n//# sourceURL=${INCH_FILE}`)(
      defineAssembly, RackDrive,
    ) as ReturnType<typeof defineAssembly>;
    insert(def);
    getSceneManager().renderScene(scene);

    expect(errorsOf(scene)).toEqual([]);
    const [turn, slide] = scene.getMates();
    expect(turn.options).toEqual({ offset: [IN, 0, 0], rotate: 30, limits: [-45, 45] });
    expect(slide.options?.offset).toEqual([0, 0, 2 * IN]);
    expect(slide.options?.limits).toEqual([0, 10 * IN]);
    expect(scene.getRelations()[0].ratio).toBeCloseTo(3 * IN, 9);
    // Turned about Z through the origin after the move: (1, 2, 3) in → (-2, 1, 3) in.
    const rack = scene.getInstances()[2];
    expect(rack.position.x).toBeCloseTo(-2 * IN, 9);
    expect(rack.position.y).toBeCloseTo(1 * IN, 9);
    expect(rack.position.z).toBeCloseTo(3 * IN, 9);
  });
});

describe("a generated assembly's errors", () => {
  setupOC();

  it("reports a misspelled id, a refused value, a configuration and a failed layout on the insert's row, and leaves nothing else of them", () => {
    const { def } = cabinetDef();
    const scene = assemblyFile([
      "insert(def, { width: 900 });",
      "insert(def, { widht: 900 });",
      "insert(def, { drawers: 9 });",
      "insert(def, 'Wide');",
      "insert(def, { drawers: 4 });",
    ].join("\n"), { insert, def });

    expect(refusals(scene)).toEqual([
      { line: 2, error: "assembly 'Cabinet': 'widht' is not one of its values — did you mean 'width'? its values are width, height, depth, drawers, drawerHeight, hingeAngle, finish" },
      { line: 3, error: "assembly 'Cabinet': 'drawers' must be at most 4, got 9" },
      { line: 4, error: "assembly 'Cabinet': 'Wide' names a configuration, and a generated assembly has none — insert it with its values, such as insert(def, { … })" },
      { line: 5, error: "assembly 'Cabinet': 4 drawers of 150 leave no room for the doors of a cabinet 720 high" },
    ]);
    // The good insert built whole; each refused one is one empty part, its
    // layout's records gone.
    const occurrences = scene.getOccurrences();
    expect(occurrences).toHaveLength(5);
    const ownedBy = (id: string) => scene.getInstances().filter(i => i.owner === id);
    expect(ownedBy("asm-0")).toHaveLength(5);
    for (const occurrence of occurrences.slice(1)) {
      expect(ownedBy(occurrence.occurrenceId).map(i => i.name)).toEqual(["Cabinet"]);
      expect(scene.getMates().filter(m => m.owner === occurrence.occurrenceId)).toEqual([]);
      expect(scene.getRelations().filter(r => r.owner === occurrence.occurrenceId)).toEqual([]);
    }
    expect(occurrences[1].generated).toEqual({ definition: "acme.cabinet", values: { widht: 900 } });
    // Only the good insert's three templates joined the scene.
    expect(generatedParts(scene)).toHaveLength(3);
    expect(generatedParts(scene).every(part => part.getError() === null)).toBe(true);
  });

  it("reports a throw from build on that part's row, and builds the rest", () => {
    const { def } = cabinetDef({ failBuild: "drawer" });
    const scene = assembly(() => {
      insert(def);
    });

    expect(errorsOf(scene)).toEqual(["part: Cabinet.build('drawer'): no drawer today"]);
    const drawer = generatedParts(scene, "drawer")[0];
    expect(drawer.getError()).toBe("Cabinet.build('drawer'): no drawer today");
    expect(solidVolume(drawer)).toBe(0);
    expect(solidVolume(generatedParts(scene, "door")[0])).toBeGreaterThan(0);
  });

  it.each([
    [{ hinge: { side: () => 1 } }, "inputs.hinge.side is a function"],
    [{ list: [1, Number.NaN] }, "inputs.list[1] is NaN"],
    [{ lookup: new Map() }, "inputs.lookup is a Map"],
    [{ "front panel": undefined }, 'inputs["front panel"] is undefined (leave it out, or give null)'],
  ])("refuses inputs that are not plain JSON, naming where — %#", (inputs, said) => {
    class Odd extends Generator.with({ size: { type: "length", default: 10 } }) {
      static id = "acme.odd";
      layout(g: Parameters<Generator["layout"]>[0]) {
        g.part("block", { inputs: { size: this.values.size } });
        g.part("block", { inputs: inputs as never });
      }
      static build(): Shape[] {
        return [];
      }
    }
    const def = defineAssembly(Odd, { label: "Odd" });
    const scene = assemblyFile("insert(def);", { insert, def });

    expect(refusals(scene)).toEqual([
      { line: 1, error: `assembly 'Odd': g.part('block'): ${said} — inputs are plain JSON: numbers, strings, booleans, null, arrays and plain objects` },
    ]);
    expect(generatedParts(scene)).toEqual([]);
  });

  it("refuses a bad part spec and a frame it can't stand a connector on", () => {
    const refusalOf = (layout: (g: any) => void): string | null => {
      class Bad extends Generator.with({}) {
        static id = "acme.bad";
        layout(g: any) {
          layout(g);
        }
        static build(): Shape[] {
          return [];
        }
      }
      const scene = assembly(() => {
        insert(defineAssembly(Bad, { label: "Bad" }));
      });
      return scene.getAllSceneObjects().find(o => o instanceof Part && o.getRefusal() !== null)?.getError() ?? null;
    };

    expect(refusalOf(g => g.part(""))).toBe("assembly 'Bad': g.part(): the first argument is the part's type, a non-empty string such as 'door' — build(type, inputs, ctx) is handed it; got ''");
    expect(refusalOf(g => g.part("door", { colour: "red" }))).toBe("assembly 'Bad': g.part('door'): unknown field 'colour' — the fields are name, inputs, connectors, appearance, material");
    expect(refusalOf(g => g.part("door", { connectors: { hinge: { origin: [0, 0, 0], z: [0, 0, 0] } } })))
      .toBe("assembly 'Bad': g.part('door'): connectors.hinge: 'z' has no length — it is the connector's axis");
    expect(refusalOf(g => g.part("door", { connectors: { hinge: { origin: [0, 0, 0], z: [0, 0, 1], x: [0, 0, 2] } } })))
      .toBe("assembly 'Bad': g.part('door'): connectors.hinge: 'x' runs along 'z' — give an X square to the connector's axis, or leave it out");
    expect(refusalOf(g => g.part("door", { connectors: { hinge: { origin: [0, 0], z: [0, 0, 1] } } })))
      .toBe("assembly 'Bad': g.part('door'): connectors.hinge: 'origin' must be [x, y, z], three finite numbers — got a list");
    expect(refusalOf(g => g.part("door").pose({ position: [0, 0] })))
      .toBe("assembly 'Bad': .pose(): 'position' must be [x, y, z], three finite numbers — got a list");
  });

  it("closes g once the layout returned", () => {
    let kept: any = null;
    class Keeper extends Generator.with({}) {
      static id = "acme.keeper";
      layout(g: any) {
        kept = g;
      }
      static build(): Shape[] {
        return [];
      }
    }
    assembly(() => {
      insert(defineAssembly(Keeper, { label: "Keeper" }));
    });
    expect(() => kept.part("late")).toThrow("g.part(): the layout has returned — g declares parts and joints only while layout(g) runs");
  });
});

describe("generated parts across renders", () => {
  setupOC();

  function render(values: Record<string, unknown>) {
    const scene = getSceneManager().startAssemblyScene();
    const { def, builds } = cabinetDef();
    insert(def, values as never);
    return { scene, builds };
  }

  it("pair by their template's identity: a joint-only change keeps every part, a new drawer count keeps the drawers", () => {
    const first = render({});
    getSceneManager().renderScene(first.scene);

    const swing = render({ hingeAngle: 120 });
    AssemblyCompare.compare(first.scene, swing.scene);
    getSceneManager().renderScene(swing.scene);
    expect(errorsOf(swing.scene)).toEqual([]);
    expect(generatedParts(swing.scene).map(part => swing.scene.isCached(part))).toEqual([true, true, true]);
    expect(swing.builds.size).toBe(0);

    // A third drawer moves the doors up and adds a runner to the carcass; the drawers stay as they were.
    const deeper = render({ drawers: 3, height: 900 });
    AssemblyCompare.compare(swing.scene, deeper.scene);
    getSceneManager().renderScene(deeper.scene);
    expect(errorsOf(deeper.scene)).toEqual([]);
    expect(generatedParts(deeper.scene).map(part => [part.partName, deeper.scene.isCached(part)]))
      .toEqual([["carcass", false], ["door", false], ["drawer", true]]);
    expect(Object.fromEntries(deeper.builds)).toEqual({ carcass: 1, door: 1 });
  });
});

describe("Generator and defineAssembly refuse", () => {
  setupOC();

  it("a picked value, naming it", () => {
    expect(() => Generator.with({ face: { picker: "face" } } as never))
      .toThrow("Generator.with(): 'face' is a picked value — a generator takes typed-in values only (numbers, lengths, angles, booleans, selects, radios, texts): the assembly that inserts it mates its parts");
  });

  it("a bad value declaration, where the module loads", () => {
    expect(() => Generator.with({ width: { type: "length", min: 10, max: 5 } } as never)).toThrow(/^Generator\.with\(\): /);
  });

  it("anything but a generator that declares its values, lays out and builds", () => {
    expect(() => defineAssembly((() => {}) as never, { label: "X" }))
      .toThrow("defineAssembly(): the first argument is the generator's class, one that extends Generator.with({ … }), got a function");
    class Bare extends Generator {
      static id = "acme.bare";
      layout() {}
      static build(): Shape[] {
        return [];
      }
    }
    expect(() => defineAssembly(Bare as never, { label: "Bare" }))
      .toThrow("defineAssembly(Bare): Bare declares no values — declare them with Generator.with({ … }): class Bare extends Generator.with({ width: { type: 'length', default: 600 } })");
    class NoBuild extends Generator.with({}) {
      static id = "acme.nobuild";
      layout() {}
    }
    expect(() => defineAssembly(NoBuild as never, { label: "N" }))
      .toThrow("defineAssembly(NoBuild): NoBuild implements no static build(type, inputs, ctx) — it builds each part its layout declares: static build(type, inputs, ctx) { return [solid]; }");
    class NoId extends Generator.with({}) {
      layout() {}
      static build(): Shape[] {
        return [];
      }
    }
    expect(() => defineAssembly(NoId as never, { label: "N" }))
      .toThrow("defineAssembly(NoId): NoId needs a static id — the generator's type, such as 'cabinet'");
    class BadId extends Generator.with({}) {
      static id = "acme cabinet";
      layout() {}
      static build(): Shape[] {
        return [];
      }
    }
    expect(() => defineAssembly(BadId as never, { label: "N" }))
      .toThrow("defineAssembly(BadId): the id 'acme cabinet' is not well formed — dot-separated names of letters, digits, '-' and '_', each starting with a letter, such as 'cabinet'");
  });

  it("bad metadata, naming the field", () => {
    const { Cabinet } = defineCabinet();
    expect(() => defineAssembly(Cabinet, {} as never)).toThrow("defineAssembly(Cabinet): 'label' must be a non-empty string, got nothing");
    expect(() => defineAssembly(Cabinet, { label: "C", connectors: [] } as never))
      .toThrow("defineAssembly(Cabinet): leave 'connectors' out — a generated assembly's connectors are its parts': g.part(type, { connectors }) in layout(g)");
    expect(() => defineAssembly(Cabinet, { label: "C", layout: ["width"] as never }))
      .toThrow(/^defineAssembly\(Cabinet\): the value 'height' has no place in the layout/);
    expect(() => defineAssembly(Cabinet, { label: "C", width: "full" as never }))
      .toThrow(/^defineAssembly\(Cabinet\): 'width' must be one of wide, wider, got '(huge|full)'$/);
    expect(() => defineAssembly(Cabinet, { label: "C", aside: { image: "./size.svg" } as never }))
      .toThrow(/^defineAssembly\(Cabinet\): /);
    expect(() => defineAssembly(Cabinet, { label: "C", aside: [{ image: "https://example.com/size.svg" }] }))
      .toThrow(/^defineAssembly\(Cabinet\): .*'https:\/\/example.com\/size.svg'/);
    expect(() => defineAssembly(Cabinet, { label: "C", aside: [{ row: ["width", "height"] }] as never }))
      .toThrow(/^defineAssembly\(Cabinet\): aside: /);
  });
});

describe("a generated assembly's schema", () => {
  setupOC();

  it("lists the values by id and derives the dialog's rows; it has no connectors of its own", () => {
    const { Cabinet } = defineCabinet();
    const schema = defineAssembly(Cabinet, { label: "Cabinet", description: "A base unit", icon: "../features/icons/cabinet.svg" }).getSchema();

    expect(schema).toMatchObject({
      kind: "assembly",
      definitionKind: "generated",
      id: "acme.cabinet",
      label: "Cabinet",
      description: "A base unit",
      icon: "../features/icons/cabinet.svg",
      layout: ["width", "height", "depth", "drawers", "drawerHeight", "hingeAngle", "finish"],
      connectors: [],
      assetBase: { layout: "definition" },
    });
    expect(Object.keys(schema.params)).toEqual(["width", "height", "depth", "drawers", "drawerHeight", "hingeAngle", "finish"]);
    expect(schema.params.drawerHeight).toMatchObject({ type: "length", default: 150, label: "Drawer height" });
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(GeneratedSchemas.assetsOf(schema)).toEqual({ definition: ["../features/icons/cabinet.svg"], class: [] });
    expect(schema.width).toBeUndefined();
    expect(schema.aside).toBeUndefined();
  });

  it("carries the dialog's width and aside, the aside's images read against the defining module", () => {
    const { Cabinet } = defineCabinet();
    const schema = defineAssembly(Cabinet, {
      label: "Cabinet",
      icon: "../features/icons/cabinet.svg",
      width: "wide",
      aside: [{ image: "../features/img/cabinet-size.svg", alt: "Width, height and depth", height: 200 }, { divider: true }, { note: "Doors swing on the hinge side" }],
    }).getSchema();

    expect(schema.width).toBe("wide");
    expect(schema.aside).toEqual([
      { image: "../features/img/cabinet-size.svg", alt: "Width, height and depth", height: 200 },
      { divider: true },
      { note: "Doors swing on the hinge side" },
    ]);
    expect(schema.assetBase).toEqual({ layout: "definition", aside: "definition" });
    expect(GeneratedSchemas.assetsOf(schema)).toEqual({
      definition: ["../features/icons/cabinet.svg", "../features/img/cabinet-size.svg"],
      class: [],
    });
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it("reads an aside with no base of its own as the class's (a schema an older engine wrote)", () => {
    const { Cabinet } = defineCabinet();
    const schema = defineAssembly(Cabinet, { label: "Cabinet", aside: [{ image: "./size.svg" }] }).getSchema();
    delete schema.assetBase.aside;
    expect(GeneratedSchemas.assetsOf(schema)).toEqual({ definition: [], class: ["./size.svg"] });
  });
});
