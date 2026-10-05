// Connector copies that follow a repeat (plan stage 4): `copy(holes, bolt)`
// inside a part body lays `bolt.instance(k)` on `holes.instance(k)` — the
// repeat's own slots, original, skips and moves (RepeatBase.getSlotMatrix),
// so a partial arc is spaced the repeat's way and an edited repeat carries
// the copies with it. Only a linear or circular repeat of the same part is
// followed, and only connectors are copied; every other statement is refused
// on its own row. A render never throws: every test asserts getError().

import { describe, it, expect, afterEach } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { getUnitRegistry } from "../units/registry.js";
import * as core from "../core/index.js";
import * as filters from "../filters/index.js";
import * as constraints from "../core/constraints/index.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import cut from "../core/cut.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import copy from "../core/copy.js";
import repeat from "../core/repeat.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import select from "../core/select.js";
import { circle } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "../rendering/scene.js";
import { SceneCompare } from "../rendering/scene-compare.js";
import { Connector } from "../features/connector.js";
import { ConnectorCopy } from "../features/connector-copy.js";
import { CopyPattern } from "../features/copy-pattern.js";
import { CopyLayout } from "../features/copy-layout.js";
import { RepeatBase } from "../features/repeat-base.js";
import { Part } from "../features/part.js";
import type { PartDefinition } from "../features/part-definition.js";
import { Matrix4 } from "../math/matrix4.js";

type Vec = { x: number; y: number; z: number };

function near(v: Vec, x: number, y: number, z: number): void {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
}

/** Every object's build error, readable — `[]` when the render is clean. */
function errors(scene: Scene): string[] {
  return scene.getAllSceneObjects()
    .filter(o => o.getError())
    .map(o => `${o.getUniqueType()}: ${o.getError()}`);
}

function copiesIn(scene: Scene): ConnectorCopy[] {
  return scene.getAllSceneObjects().filter((o): o is ConnectorCopy => o instanceof ConnectorCopy);
}

type Plate = {
  plate: SceneObject;
  /** The Ø20 hole through the plate at (40, 0), a `cut()`. */
  hole: SceneObject;
  /** `bolt` on the hole's rim: origin (40, 0, 10), Z up. */
  bolt: Connector;
};

type Flange = Plate & {
  holes: RepeatBase;
  statement: SceneObject;
  /** A connector on the rim of each instance the repeat placed (`ref<k>`), by slot. */
  refs: Map<number, Connector>;
};

/**
 * A 300 × 300 × 10 plate centred on the origin with a Ø20 hole at (40, 0)
 * cut through it and `bolt` on the hole's rim; then `repeatIt` repeats the
 * hole, `copyIt` follows that repeat (by default `copy(holes, bolt)`), and a
 * reference connector lands on the rim of every instance the repeat placed —
 * `holes.instance(k).startEdges()`, the geometry the copies must sit on —
 * unless `refs` is off (a refused statement has nothing to hold against).
 */
function flange(
  repeatIt: (hole: SceneObject) => unknown,
  copyIt: (holes: RepeatBase, bolt: Connector, plate: Plate) => unknown = (holes, bolt) => copy(holes as never, bolt),
  name = "flange",
  { refs = true }: { refs?: boolean } = {},
): Flange {
  const out = { refs: new Map<number, Connector>() } as Flange;
  part(name, () => {
    plateWithHole(out);
    out.holes = repeatIt(out.hole) as RepeatBase;
    out.statement = copyIt(out.holes, out.bolt, out) as SceneObject;
    if (!refs) {
      return;
    }
    const slots = out.holes.getInstanceSlots();
    slots.forEach((roots, slot) => {
      if (roots && slot !== out.holes.getOriginalSlot()) {
        const instance = out.holes.instance(slot) as unknown as { startEdges(): unknown };
        out.refs.set(slot, connector(`ref${slot}`, instance.startEdges() as never) as unknown as Connector);
      }
    });
  });
  return out;
}

/** The plate, its hole, and `bolt` on the hole's rim — written into `out`. */
function plateWithHole(out: Plate): void {
  sketch("xy", () => {
    testRect(300, 300, { at: [-150, -150] });
  });
  const e = extrude(10);
  out.plate = e as unknown as SceneObject;
  sketch(e.endFaces(), () => {
    circle([40, 0], 20);
  });
  const hole = cut();
  out.hole = hole as unknown as SceneObject;
  out.bolt = connector("bolt", hole.startEdges()) as unknown as Connector;
}

/** Each copy sits on its instance's rim — origin and Z axis — and the family is exactly the repeat's slots. */
function expectOnHoles(made: Flange): void {
  const family = made.bolt.getFamily()!;
  expect(family.statement).toBe(made.statement);
  expect(family.originalSlot).toBe(made.holes.getOriginalSlot());
  expect(family.slotCount).toBe(made.holes.getInstanceSlots().length);
  expect(family.getCopies().map(c => c.slot)).toEqual([...made.refs.keys()]);
  expect(made.refs.size).toBeGreaterThan(0);
  for (const [slot, ref] of made.refs) {
    const frame = made.bolt.instance(slot).getFrame();
    const want = ref.getFrame();
    near(frame.origin, want.origin.x, want.origin.y, want.origin.z);
    near(frame.normal, want.normal.x, want.normal.y, want.normal.z);
  }
  expect(made.bolt.instance(made.holes.getOriginalSlot())).toBe(made.bolt);
}

describe("copy(pattern, …connectors) — following a repeat", () => {
  setupOC();

  describe("bolt.instance(k) sits on holes.instance(k)", () => {
    type Case = { name: string; repeatIt: (hole: SceneObject) => unknown; slots: number[] };
    const cases: Case[] = [
      {
        name: "a circular repeat",
        repeatIt: hole => repeat("circular", "z", { count: 6, angle: 360 }, hole as never),
        slots: [1, 2, 3, 4, 5],
      },
      {
        name: "a linear repeat",
        repeatIt: hole => repeat("linear", "x", { count: 3, offset: 30 }, hole as never),
        slots: [1, 2],
      },
      {
        name: "a grid, the first axis slowest",
        repeatIt: hole => repeat("linear", ["x", "y"], { count: [2, 3], offset: [30, 30] }, hole as never),
        slots: [1, 2, 3, 4, 5],
      },
      {
        name: "a centered linear repeat, the original on the centre slot",
        repeatIt: hole => repeat("linear", "x", { count: 3, offset: 30, centered: true }, hole as never),
        slots: [0, 2],
      },
      {
        name: "a grid with a skipped cell",
        repeatIt: hole => repeat("linear", ["x", "y"], { count: [2, 3], offset: [30, 30], skip: [[0, 2]] }, hole as never),
        slots: [1, 3, 4, 5],
      },
      {
        name: "a circular repeat with a skipped step",
        repeatIt: hole => repeat("circular", "z", { count: 6, angle: 360, skip: [2, 4] }, hole as never),
        slots: [1, 3, 5],
      },
    ];

    for (const c of cases) {
      it(`for ${c.name}`, () => {
        const made = flange(c.repeatIt);
        const scene = render();
        expect(errors(scene)).toEqual([]);

        expect([...made.refs.keys()]).toEqual(c.slots);
        expectOnHoles(made);
      });
    }

    it("turns each copy's frame with its instance, X axis included", () => {
      const made = flange(hole => repeat("circular", "z", { count: 4, angle: 360 }, hole as never));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      for (const slot of [1, 2, 3]) {
        const a = (slot * 90 * Math.PI) / 180;
        const frame = made.bolt.instance(slot).getFrame();
        near(frame.origin, 40 * Math.cos(a), 40 * Math.sin(a), 10);
        near(frame.xDirection, Math.cos(a), Math.sin(a), 0);
        near(frame.normal, 0, 0, 1);
      }
    });
  });

  it("follows a partial arc the repeat's way — 90° over 4 steps 30°, where copy('circular') steps 22.5° (B4)", () => {
    let pin: Connector | null = null;
    const made = flange(
      hole => repeat("circular", "z", { count: 4, angle: 90 }, hole as never),
      (holes, bolt) => {
        const statement = copy(holes as never, bolt);
        pin = connector("pin", select(face().planar().onPlane("xy", 10))).offset(40, 0, 0) as unknown as Connector;
        copy("circular", "z", { count: 4, angle: 90 }, pin as never);
        return statement;
      },
    );
    const scene = render();
    expect(errors(scene)).toEqual([]);

    expectOnHoles(made);
    for (const slot of [1, 2, 3]) {
      const followed = (slot * 30 * Math.PI) / 180;
      near(made.bolt.instance(slot).getFrame().origin, 40 * Math.cos(followed), 40 * Math.sin(followed), 10);
      const own = (slot * 22.5 * Math.PI) / 180;
      near(pin!.instance(slot).getFrame().origin, 40 * Math.cos(own), 40 * Math.sin(own), 10);
    }
  });

  it("serializes as a copy-pattern row that files with the part's connectors, its copies folded under it", () => {
    const made = flange(hole => repeat("circular", "z", { count: 4, angle: 360, skip: [2] }, hole as never));
    const scene = render();
    expect(errors(scene)).toEqual([]);

    expect(made.statement).toBeInstanceOf(CopyPattern);
    const row = scene.getRenderedObject(made.statement)!;
    expect(row.type).toBe("copy-pattern");
    expect(row.hideChildren).toBe(true);
    expect(row.visible).toBe(true);
    expect(row.object).toEqual({
      connectorCopies: {
        seeds: [{ id: made.bolt.id, name: "bolt" }],
        originalSlot: 0,
        slotCount: 4,
        slots: [1, 3],
        connectorsOnly: true,
      },
    });
    // It copies connectors only: no solid of its own, the plate untouched.
    expect(made.statement.getShapes()).toEqual([]);
    const copies = copiesIn(scene);
    expect(copies.map(c => c.getParent())).toEqual([made.statement, made.statement]);
    for (const c of copies) {
      const copyRow = scene.getRenderedObject(c)!;
      expect(copyRow.type).toBe("connector");
      expect(copyRow.parentId).toBe(made.statement.id);
      expect(copyRow.name).toBe(c.label());
      expect(copyRow.object.copy).toEqual({ slot: c.slot, seedId: made.bolt.id });
    }
    // The part's registries walk into the family, names stay declared ones.
    const owner = made.bolt.getParent() as Part;
    expect(owner.getConnectors().slice(0, 3)).toEqual([made.bolt, ...copies]);
    expect(owner.resolveConnector("bolt", 3)).toBe(copies[1]);
    expect(Object.keys(owner.getNamedConnectors())).toEqual(["bolt", "ref1", "ref3"]);
  });

  describe("instance()", () => {
    it("names the repeat that skipped a slot, and the copy's range", () => {
      const made = flange(hole => repeat("circular", "z", { count: 6, angle: 360, skip: [2] }, hole as never));
      const scene = render();
      expect(errors(scene)).toEqual([]);
      // The messages read the statements' locations when they are raised.
      made.holes.setSourceLocation({ filePath: "/ws/parts/flange.part.js", line: 12, column: 16 });
      made.statement.setSourceLocation({ filePath: "/ws/parts/flange.part.js", line: 14, column: 2 });

      expect(() => made.bolt.instance(2)).toThrow(
        "bolt.instance(2) was skipped by the repeat at flange.part.js:12 that the copy at flange.part.js:14 follows",
      );
      expect(() => made.bolt.instance(6))
        .toThrow("bolt.instance(6) is out of range — the copy at flange.part.js:14 makes instances 0–5");
      expect(() => made.bolt.instance(-1)).toThrow("bolt.instance(-1) is out of range");
    });

    it("a repeat of one instance makes only the original's slot", () => {
      const made = flange(hole => repeat("linear", "x", { count: 1, offset: 30 }, hole as never));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      expect(copiesIn(scene)).toEqual([]);
      expect(made.bolt.instance(0)).toBe(made.bolt);
      expect(() => made.bolt.instance(1))
        .toThrow("bolt.instance(1) is out of range — the copy statement makes only instance 0");
    });
  });

  describe("refusals", () => {
    type Case = {
      name: string;
      repeatIt?: (hole: SceneObject) => unknown;
      copyIt: (holes: RepeatBase, bolt: Connector, plate: Plate) => unknown;
      message: string;
    };
    const circular = (hole: SceneObject) => repeat("circular", "z", { count: 4, angle: 360 }, hole as never);
    const cases: Case[] = [
      {
        name: "a mirror repeat",
        repeatIt: hole => repeat("mirror", "yz", hole as never),
        copyIt: (holes, bolt) => copy(holes as never, bolt),
        message: "copy(): copy(pattern, …) follows a linear or circular repeat() — a mirror repeat reflects its "
          + "instance, and a copied connector is never reflected",
      },
      {
        name: "a rotate repeat",
        repeatIt: hole => repeat("rotate", "z", 90, hole as never),
        copyIt: (holes, bolt) => copy(holes as never, bolt),
        message: "copy(): copy(pattern, …) follows a linear or circular repeat() — not a rotate or matrix repeat; "
          + "turn a connector with copy('circular', axis, options, …)",
      },
      {
        name: "a matrix repeat",
        repeatIt: hole => repeat(Matrix4.fromTranslation(0, 50, 0), hole as never),
        copyIt: (holes, bolt) => copy(holes as never, bolt),
        message: "copy(): copy(pattern, …) follows a linear or circular repeat() — not a rotate or matrix repeat; "
          + "turn a connector with copy('circular', axis, options, …)",
      },
      {
        name: "a pattern that isn't a repeat",
        repeatIt: circular,
        copyIt: (_holes, bolt, plate) => copy(plate.hole as never, bolt),
        message: "copy(): copy(pattern, …) follows a repeat() — got cut(); pass the repeat() itself, "
          + "e.g. copy(holes, bolt)",
      },
      {
        name: "a solid among the targets",
        repeatIt: circular,
        copyIt: (holes, bolt, plate) => copy(holes as never, bolt, plate.plate as never),
        message: "copy(): copy(pattern, …) copies connectors only — got extrude(); copy solids with "
          + "copy('linear' | 'circular', axis, options, …)",
      },
      {
        name: "no connector to copy",
        repeatIt: circular,
        copyIt: holes => copy(holes as never),
        message: "copy(): copy(pattern, …) needs the connectors to copy — e.g. copy(holes, bolt)",
      },
      {
        name: "a copy of a copy",
        repeatIt: circular,
        copyIt: (holes, bolt) => {
          copy("linear", "y", { count: 2, offset: 30 }, bolt);
          return copy(holes as never, bolt.instance(1));
        },
        message: "copy(): bolt.instance(1) is itself a copy and isn't copied again — copy bolt instead "
          + "(a grid is one two-axis linear copy)",
      },
      {
        name: "a second copy statement of the same connector",
        repeatIt: circular,
        copyIt: (holes, bolt) => {
          copy(holes as never, bolt);
          return copy(holes as never, bolt);
        },
        message: "copy(): bolt is already copied by the copy statement — one copy statement per connector "
          + "(a grid is one two-axis linear copy)",
      },
      {
        name: "a pattern copy after the connector's own copy()",
        repeatIt: circular,
        copyIt: (holes, bolt) => {
          copy("circular", "z", { count: 3, angle: 360 }, bolt);
          return copy(holes as never, bolt);
        },
        message: "copy(): bolt is already copied by the copy statement — one copy statement per connector "
          + "(a grid is one two-axis linear copy)",
      },
      {
        name: "a centered circular repeat (B3)",
        repeatIt: hole => repeat("circular", "z", { count: 4, angle: 360, centered: true }, hole as never),
        copyIt: (holes, bolt) => copy(holes as never, bolt),
        message: "copy(): a connector can't follow a centered circular repeat yet — drop centered on the repeat; "
          + "its pattern then starts at the original",
      },
      {
        name: "a repeat numbering no instance",
        repeatIt: hole => repeat("linear", "x", { count: 0, offset: 30 }, hole as never),
        copyIt: (holes, bolt) => copy(holes as never, bolt),
        message: "copy(): the repeat numbers no instances — a connector copy needs a count of at least 1",
      },
    ];

    for (const c of cases) {
      it(`refuses ${c.name} on the statement's own row`, () => {
        const made = flange(c.repeatIt ?? circular, c.copyIt, "flange", { refs: false });
        const scene = render();
        const refused = made.statement;

        expect(refused.getError()).toBe(c.message);
        expect(scene.getRenderedObject(refused)!.errorMessage).toBe(c.message);
        expect(errors(scene)).toEqual([`${refused.getUniqueType()}: ${c.message}`]);
        // The refused statement made nothing.
        expect(refused.getChildren()).toEqual([]);
        expect(refused.getShapes()).toEqual([]);
      });
    }

    it("refuses following a refused repeat — it has no instances to follow", () => {
      let refusedRepeat: SceneObject | null = null;
      let statement: SceneObject | null = null;
      part("flange", () => {
        const out = {} as Plate;
        plateWithHole(out);
        const pivot = connector("pivot", select(face().planar().onPlane("xy", 10))) as unknown as Connector;
        refusedRepeat = repeat("linear", "x", { count: 2, offset: 30 }, pivot as never) as unknown as SceneObject;
        statement = copy(refusedRepeat as never, out.bolt) as unknown as SceneObject;
      });
      const scene = render();
      const message = "copy(): the repeat this copy follows is refused, so it has no instances to follow — "
        + "fix that repeat first";
      expect(statement!.getError()).toBe(message);
      expect(errors(scene)).toEqual([
        `${refusedRepeat!.getUniqueType()}: ${refusedRepeat!.getError()}`,
        `${statement!.getUniqueType()}: ${message}`,
      ]);
    });

    it("refuses a repeat of another part — a connector follows a repeat of its own part", () => {
      const donor = flange(hole => repeat("circular", "z", { count: 4, angle: 360 }, hole as never), () => null, "donor");
      let statement: SceneObject | null = null;
      part("thief", () => {
        const out = {} as Plate;
        plateWithHole(out);
        statement = copy(donor.holes as never, out.bolt) as unknown as SceneObject;
      });
      const scene = render();
      const message = `copy(): the repeat belongs to part "donor" — a connector follows a repeat in its own part's body`;
      expect(statement!.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${statement!.getUniqueType()}: ${message}`]);
    });

    it("refuses another part's connector — a part's connectors are copied inside that part's body", () => {
      const donor = flange(hole => repeat("circular", "z", { count: 4, angle: 360 }, hole as never), () => null, "donor");
      const made = flange(
        hole => repeat("circular", "z", { count: 4, angle: 360 }, hole as never),
        holes => copy(holes as never, donor.bolt),
        "thief",
      );
      const scene = render();
      const message = `copy(): bolt belongs to part "donor" — a part's connectors are copied inside that part's body`;
      expect(made.statement.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${made.statement.getUniqueType()}: ${message}`]);
      expect(donor.bolt.getFamily()).toBeNull();
    });

    it("refuses the form inside a sketch", () => {
      let statement: SceneObject | null = null;
      const made = flange(
        hole => repeat("circular", "z", { count: 4, angle: 360 }, hole as never),
        (holes, bolt) => {
          sketch("xy", () => {
            testRect(10, 10, { at: [120, 120] });
            statement = copy(holes as never, bolt) as unknown as SceneObject;
          });
          return statement;
        },
      );
      const scene = render();
      const message = "copy(): connectors aren't copied inside a sketch — copy bolt in the part body, outside sketch()";
      expect(made.statement.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${made.statement.getUniqueType()}: ${message}`]);
      expect(made.bolt.getFamily()).toBeNull();
    });

    it("refuses the form at an assembly's top level — it is part-only", () => {
      getSceneManager().startAssemblyScene();
      const bay = connector("bay", [0, 0, 20]);
      const statement = copy(bay as never, bay) as unknown as SceneObject;
      const scene = getCurrentAssembly();
      getSceneManager().renderScene(scene);
      const message = "copy(): copy(pattern, …) follows a repeat() inside a part's body — at an assembly's top "
        + "level copy a connector with copy('linear' | 'circular', axis, options, …)";
      expect(statement.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${statement.getUniqueType()}: ${message}`]);
      expect((bay as unknown as Connector).getFamily()).toBeNull();
    });
  });

  describe("the cache", () => {
    it("reuses the copies on an unchanged render, a linear repeat's opaque moves included", () => {
      const manager = getSceneManager();
      const author = () => flange(hole => repeat("linear", "x", { count: 3, offset: 30 }, hole as never));

      const first = author();
      render();
      const firstScene = manager.currentScene;
      const firstIds = [1, 2].map(k => first.bolt.instance(k).id);

      const again = manager.startScene();
      const second = author();
      again.materializeLeftoverDefinitions();
      SceneCompare.compare(firstScene, again);
      expect(again.isCached(second.statement)).toBe(true);
      const cached = copiesIn(again);
      expect(cached.map(c => again.isCached(c))).toEqual([true, true]);
      const scene = render();
      expect(errors(scene)).toEqual([]);
      expect(cached.map(c => c.id)).toEqual(firstIds);
      near(second.bolt.instance(2).getFrame().origin, 100, 0, 10);
    });

    it("moves the copies when the repeat is edited", () => {
      const manager = getSceneManager();
      const author = (count: number) => flange(hole => repeat("circular", "z", { count, angle: 360 }, hole as never));

      author(4);
      render();
      const firstScene = manager.currentScene;

      const changed = manager.startScene();
      const edited = author(6);
      changed.materializeLeftoverDefinitions();
      SceneCompare.compare(firstScene, changed);
      expect(changed.isCached(edited.statement)).toBe(false);
      expect(copiesIn(changed).some(c => changed.isCached(c))).toBe(false);
      const scene = render();
      expect(errors(scene)).toEqual([]);
      expect(copiesIn(scene)).toHaveLength(5);
      expectOnHoles(edited);
      near(edited.bolt.instance(1).getFrame().origin, 20, 40 * Math.sin(Math.PI / 3), 10);
    });

    it("compares each follow move by the repeat and the slot", () => {
      const author = (count: number) => {
        let holes: RepeatBase | null = null;
        part("flange", () => {
          const out = {} as Plate;
          plateWithHole(out);
          holes = repeat("linear", "x", { count, offset: 30 }, out.hole as never) as unknown as RepeatBase;
        });
        getSceneManager().currentScene.materializeLeftoverDefinitions();
        return CopyLayout.follow(holes!);
      };
      const a = author(3);
      getSceneManager().startScene();
      const b = author(3);
      getSceneManager().startScene();
      const c = author(4);

      expect(a.slots.map(s => s.slot)).toEqual([1, 2]);
      expect(a.slots.every((slot, i) => slot.matrix.equals(b.slots[i].matrix))).toBe(true);
      expect(a.slots[0].matrix.equals(a.slots[1].matrix)).toBe(false);
      expect(a.slots[0].matrix.equals(c.slots[0].matrix)).toBe(false);
    });
  });
});

/** The assembly scene the manager is on. */
function getCurrentAssembly(): Scene {
  return getSceneManager().currentScene;
}

// ---------------------------------------------------------------------------
// Foreign units: the definition lives in its own inch file (sourceURL), so the
// unit registry can give it a unit different from the consuming scene's.
// ---------------------------------------------------------------------------

const INCH_FLANGE_FILE = "/ws/fixtures/inch-follow-flange.fluid.js";

/** A 4 × 4 × 0.5 in plate, a Ø0.4 in hole 0.75 in out along X repeated 4 × around Z, followed by bolt. */
function defineInchFlange(): PartDefinition {
  const source = `
    return part('InchFlange', () => {
      sketch('xy', () => {
        testRect(4, 4, { at: [-2, -2] });
      });
      const e = extrude(0.5);
      sketch(e.endFaces(), () => {
        circle([0.75, 0], 0.4);
      });
      const hole = cut();
      const holes = repeat('circular', 'z', { count: 4, angle: 360 }, hole);
      const bolt = connector('bolt', hole.startEdges());
      copy(holes, bolt);
    });
    //# sourceURL=${INCH_FLANGE_FILE}
  `;
  const globals: Record<string, unknown> = { ...core, ...filters, ...constraints, testRect };
  const names = Object.keys(globals);
  const fn = new Function(...names, `"use strict";\n${source}`);
  return fn(...names.map(n => globals[n])) as PartDefinition;
}

describe("copy(pattern, …) in a foreign-unit part", () => {
  setupOC();

  afterEach(() => {
    getSceneManager().projectUnit = "mm";
  });

  it("rescales the followed copies with the rest of the part", () => {
    getSceneManager().projectUnit = "mm";
    const scene = getSceneManager().startAssemblyScene();
    getUnitRegistry().declare(INCH_FLANGE_FILE, "in");
    const inst = insert(defineInchFlange());
    getSceneManager().renderScene(scene);
    expect(errors(scene)).toEqual([]);

    const bolt = inst.connectors.bolt;
    near(bolt.getFrame().origin, 19.05, 0, 12.7);
    near(bolt.instance(1).getFrame().origin, 0, 19.05, 12.7);
    near(bolt.instance(2).getFrame().origin, -19.05, 0, 12.7);
    const copy1 = bolt.instance(1).connector;
    expect(copy1).toBeInstanceOf(ConnectorCopy);
    expect(copy1.getUnit()).toBe("mm");
  });
});

// ---------------------------------------------------------------------------
// Assemblies: a followed copy is an ordinary mate side.
// ---------------------------------------------------------------------------

describe("copy(pattern, …) in an assembly", () => {
  setupOC();

  it("mates to f.connectors.bolt.instance(3), serializing the copy's id", () => {
    getSceneManager().startScene();
    const flangeDef = part("flange", () => {
      const out = {} as Plate;
      plateWithHole(out);
      const holes = repeat("circular", "z", { count: 6, angle: 360 }, out.hole as never);
      copy(holes, out.bolt);
    }) as unknown as PartDefinition;
    const pinDef = part("pin", () => {
      sketch("xy", () => {
        testRect(4, 4, { at: [-2, -2] });
      });
      extrude(20);
      connector("head", select(face().planar().onPlane("xy", 0)));
    }) as unknown as PartDefinition;
    const scene = getSceneManager().startAssemblyScene();
    const f = insert(flangeDef).grounded();
    const b = insert(pinDef);
    mate("fastened", f.connectors.bolt.instance(3), b.connectors.head);
    getSceneManager().renderScene(scene);
    expect(errors(scene)).toEqual([]);

    const copy3 = f.record.part.resolveConnector("bolt", 3)!;
    expect(copy3).toBeInstanceOf(ConnectorCopy);
    const [serialized] = (scene as unknown as { getSerializedMates(): { connectorA: unknown }[] }).getSerializedMates();
    expect(serialized.connectorA).toEqual({ instanceId: f.record.instanceId, connectorId: copy3.id });
    // Half a turn around Z from (40, 0, 10).
    near(copy3.getFrame().origin, -40, 0, 10);
    expect(() => f.connectors.bolt.instance(6)).toThrow("bolt.instance(6) is out of range");
  });
});
