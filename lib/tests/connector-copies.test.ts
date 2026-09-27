// Connector copies (plan stage 1): `copy('linear' | 'circular', …, bolt)`
// inside a part() body gives the connector a family — one ConnectorCopy per
// placed slot, the seed's frame moved rigidly by that slot's matrix, folded
// under the copy statement and addressed as `bolt.instance(k)`. The part's
// registries walk into the family, mates and replicate take copies as
// ordinary connectors, and every statement the family rules refuse reports
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
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import copy from "../core/copy.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import replicate from "../core/replicate.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "../rendering/scene.js";
import { SceneCompare } from "../rendering/scene-compare.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { BoundConnector, Connector } from "../features/connector.js";
import { ConnectorCopy, ConnectorCopyRules } from "../features/connector-copy.js";
import { FreePoint } from "../features/connector-frame.js";
import { Point } from "../math/point.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { CopyBase } from "../features/copy-base.js";
import { Part } from "../features/part.js";
import type { PartDefinition } from "../features/part-definition.js";
import { Plane } from "../math/plane.js";
import { synthesizeApplyFeature } from "../selection/explain.js";
import { scopedSceneBefore } from "../selection/types.js";
import { faceRefsWhere, findSolid, setLocation } from "./selection/pick-helpers.js";

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

type Flange = {
  plate: SceneObject;
  bolt: Connector;
  statement: SceneObject;
};

/**
 * A 100 × 100 × 10 plate centred on the origin with the connector `bolt` on
 * its top face, 30 along X: origin (30, 0, 10), X along world X, Z up. Then
 * whatever `copyIt` writes — inside the part, where connectors live.
 */
function flange(copyIt: (bolt: Connector, plate: SceneObject) => unknown, name = "flange"): Flange {
  const out = {} as Flange;
  part(name, () => {
    sketch("xy", () => {
      testRect(100, 100, { at: [-50, -50] });
    });
    out.plate = extrude(10).new() as unknown as SceneObject;
    out.bolt = (connector("bolt", select(face().planar().onPlane("xy", 10))) as unknown as Connector).offset(30, 0, 0);
    out.statement = copyIt(out.bolt, out.plate) as SceneObject;
  });
  return out;
}

function frameOf(connector: Connector): Plane {
  return connector.getFrame();
}

describe("connector copies", () => {
  setupOC();

  describe("frames", () => {
    it("a linear copy moves the seed's frame along the axis, axes unchanged", () => {
      const made = flange(bolt => copy("linear", "x", { count: 3, offset: 20 }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      near(frameOf(made.bolt).origin, 30, 0, 10);
      near(frameOf(made.bolt).xDirection, 1, 0, 0);
      const copies = copiesIn(scene);
      expect(copies.map(c => c.slot)).toEqual([1, 2]);
      near(frameOf(copies[0]).origin, 50, 0, 10);
      near(frameOf(copies[1]).origin, 70, 0, 10);
      for (const c of copies) {
        near(frameOf(c).xDirection, 1, 0, 0);
        near(frameOf(c).normal, 0, 0, 1);
        expect(c.seed).toBe(made.bolt);
      }
    });

    it("a grid numbers its cells with the first axis slowest", () => {
      const made = flange(bolt => copy("linear", ["x", "y"], { count: [2, 3], offset: [20, 15] }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      // Cell (i, j) is slot i·3 + j; the original holds (0, 0).
      const expected: [number, number, number][] = [[1, 30, 15], [2, 30, 30], [3, 50, 0], [4, 50, 15], [5, 50, 30]];
      for (const [slot, x, y] of expected) {
        near(frameOf(made.bolt.instance(slot)).origin, x, y, 10);
      }
      expect(made.bolt.instance(0)).toBe(made.bolt);
    });

    it("a circular copy turns the seed's frame about the axis — origin and X axis alike", () => {
      const made = flange(bolt => copy("circular", "z", { count: 6, angle: 360 }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      for (let slot = 1; slot < 6; slot++) {
        const a = (slot * 60 * Math.PI) / 180;
        const frame = frameOf(made.bolt.instance(slot));
        near(frame.origin, 30 * Math.cos(a), 30 * Math.sin(a), 10);
        near(frame.xDirection, Math.cos(a), Math.sin(a), 0);
        near(frame.yDirection, -Math.sin(a), Math.cos(a), 0);
        near(frame.normal, 0, 0, 1);
      }
    });

    it("a centered linear copy leaves the seed on the centre slot", () => {
      const made = flange(bolt => copy("linear", "x", { count: 3, offset: 20, centered: true }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      expect(made.bolt.instance(1)).toBe(made.bolt);
      near(frameOf(made.bolt.instance(0)).origin, 10, 0, 10);
      near(frameOf(made.bolt.instance(2)).origin, 50, 0, 10);
    });
  });

  describe("instance()", () => {
    it("returns the seed at the original's slot and each copy at its own", () => {
      const made = flange(bolt => copy("circular", "z", { count: 4, angle: 360 }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      const copies = copiesIn(scene);
      expect(made.bolt.instance(0)).toBe(made.bolt);
      expect([1, 2, 3].map(k => made.bolt.instance(k))).toEqual(copies);
      expect(copies.map(c => c.label())).toEqual(["bolt.instance(1)", "bolt.instance(2)", "bolt.instance(3)"]);
      expect(made.bolt.label()).toBe("bolt");

      // Bound to an instance, the copy keeps the instance id.
      const bound = made.bolt.boundTo("inst-7").instance(2);
      expect(bound.connector).toBe(copies[1]);
      expect(bound.instanceId).toBe("inst-7");
      expect(bound.label()).toBe("bolt.instance(2)");
    });

    it("names the copy statement for a skipped slot and a slot out of range", () => {
      const made = flange(bolt => copy("circular", "z", { count: 6, angle: 360, skip: [2] }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);
      // The messages read the statement's location when they are raised.
      made.statement.setSourceLocation({ filePath: "/ws/parts/flange.part.js", line: 14, column: 2 });

      expect(() => made.bolt.instance(2)).toThrow("bolt.instance(2) was skipped by the copy at flange.part.js:14");
      expect(() => made.bolt.instance(6))
        .toThrow("bolt.instance(6) is out of range — the copy at flange.part.js:14 makes instances 0–5");
      expect(() => made.bolt.instance(-1)).toThrow("bolt.instance(-1) is out of range");
      expect(() => made.bolt.instance(1.5)).toThrow("bolt.instance(1.5) is out of range");
    });

    it("a count of one makes only the original's slot", () => {
      const made = flange(bolt => copy("linear", "x", { count: 1, offset: 20 }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      expect(copiesIn(scene)).toEqual([]);
      expect(made.bolt.instance(0)).toBe(made.bolt);
      expect(() => made.bolt.instance(1))
        .toThrow("bolt.instance(1) is out of range — the copy statement makes only instance 0");
    });

    it("a connector nothing copies has no copies", () => {
      const made = flange(() => null);
      render();
      expect(() => made.bolt.instance(1)).toThrow("bolt has no copies — copy it with copy(…) in its part");
    });

    it("a copy is read-only: rotate, offset and instance point at the seed", () => {
      const made = flange(bolt => copy("linear", "x", { count: 2, offset: 20 }, bolt));
      render();
      const copied = made.bolt.instance(1);
      expect(() => copied.rotate("z", 90)).toThrow("bolt.instance(1) is a copy — rotate bolt itself and its copies follow");
      expect(() => copied.offset(0, 0, 5)).toThrow("bolt.instance(1) is a copy — offset bolt itself and its copies follow");
      expect(() => copied.instance(0))
        .toThrow("bolt.instance(1) is a copy — address copies on the connector itself: bolt.instance(0)");
    });
  });

  describe("the copy statement", () => {
    it("copies solids and connectors together, the seed's marker intact (B2)", () => {
      const made = flange((bolt, plate) => copy("linear", "x", { count: 2, offset: 150 }, plate, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      // The statement owns the two plates; the seed kept its meta vertex.
      expect(made.statement.getShapes().filter(s => s.getType() === "solid")).toHaveLength(2);
      expect(made.bolt.getShapes({ excludeMeta: false, excludeGuide: false })).toHaveLength(1);
      near(frameOf(made.bolt.instance(1)).origin, 180, 0, 10);
      const rendered = scene.getRenderedObject(made.statement)!;
      expect(rendered.visible).toBe(true);
      expect(rendered.sceneShapes.filter(s => s.shapeType === "solid")).toHaveLength(2);
      // It copies a solid too, so the timeline keeps it among the features.
      expect(rendered.object.connectorCopies.connectorsOnly).toBe(false);
    });

    it("a statement whose only targets are connectors copies no shapes — never everything before it", () => {
      const made = flange(bolt => copy("linear", "x", { count: 3, offset: 20 }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      expect(made.statement.getShapes()).toEqual([]);
      expect(made.plate.getShapes().filter(s => s.getType() === "solid")).toHaveLength(1);
      // Still shown: its copies draw.
      expect(scene.getRenderedObject(made.statement)!.visible).toBe(true);
    });

    it("a copy() without targets never copies connectors", () => {
      const made = flange(() => copy("linear", "x", { count: 2, offset: 150 }));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      expect(copiesIn(scene)).toEqual([]);
      expect(made.bolt.getFamily()).toBeNull();
      expect(made.bolt.getShapes({ excludeMeta: false, excludeGuide: false })).toHaveLength(1);
      expect(made.statement.getShapes().filter(s => s.getType() === "solid")).toHaveLength(2);
    });

    it("renders its copies folded under it, each serialized with its slot and seed", () => {
      const made = flange(bolt => copy("circular", "z", { count: 4, angle: 360, skip: [2] }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);

      const statementRow = scene.getRenderedObject(made.statement)!;
      expect(statementRow.hideChildren).toBe(true);
      expect(statementRow.object).toEqual({
        connectorCopies: {
          seeds: [{ id: made.bolt.id, name: "bolt" }],
          originalSlot: 0,
          slotCount: 4,
          slots: [1, 3],
          connectorsOnly: true,
        },
      });
      const copies = copiesIn(scene);
      expect(copies.map(c => c.getParent())).toEqual([made.statement, made.statement]);
      for (const c of copies) {
        const row = scene.getRenderedObject(c)!;
        expect(row.type).toBe("connector");
        expect(row.parentId).toBe(made.statement.id);
        expect(row.name).toBe(c.label());
        expect(row.object.name).toBe("bolt");
        expect(row.object.copy).toEqual({ slot: c.slot, seedId: made.bolt.id });
        expect(row.visible).toBe(true);
      }
      // A statement copying no connectors serializes as before.
      const plain = flange((_bolt, plate) => copy("linear", "x", { count: 2, offset: 150 }, plate), "plain");
      render();
      expect(plain.statement.serialize()).toEqual({});
    });
  });

  describe("family rules", () => {
    type Case = { name: string; write: (bolt: Connector, plate: SceneObject) => unknown; message: string };
    const cases: Case[] = [
      {
        name: "a second copy of the same connector",
        write: bolt => {
          copy("linear", "x", { count: 2, offset: 20 }, bolt);
          return copy("circular", "z", { count: 4, angle: 360 }, bolt);
        },
        message: "copy(): bolt is already copied by the copy statement — one copy statement per connector "
          + "(a grid is one two-axis linear copy)",
      },
      {
        name: "a copy of a copy",
        write: bolt => {
          copy("linear", "x", { count: 2, offset: 20 }, bolt);
          return copy("linear", "y", { count: 2, offset: 20 }, bolt.instance(1));
        },
        message: "copy(): bolt.instance(1) is itself a copy and isn't copied again — copy bolt instead "
          + "(a grid is one two-axis linear copy)",
      },
      {
        name: "a connector listed twice",
        write: bolt => copy("linear", "x", { count: 2, offset: 20 }, bolt, bolt),
        message: "copy(): bolt is listed twice — list each connector once",
      },
      {
        name: "a circular centered copy",
        write: bolt => copy("circular", "z", { count: 4, angle: 360, centered: true }, bolt),
        message: "copy(): a circular copy of a connector can't be centered yet — drop centered; "
          + "the pattern then starts at the connector",
      },
      {
        name: "a linear count below one",
        write: bolt => copy("linear", ["x", "y"], { count: [2, 0], offset: [20, 20] }, bolt),
        message: "copy(): a connector copy needs a count of at least 1 on every axis (got 0)",
      },
      {
        name: "a circular count below one",
        write: bolt => copy("circular", "z", { count: 0, angle: 360 }, bolt),
        message: "copy(): a connector copy needs a count of at least 1 (got 0)",
      },
      {
        name: "a connector among solids — nothing is copied",
        write: (bolt, plate) => copy("circular", "z", { count: 4, angle: 360, centered: true }, plate, bolt),
        message: "copy(): a circular copy of a connector can't be centered yet — drop centered; "
          + "the pattern then starts at the connector",
      },
    ];

    for (const c of cases) {
      it(`refuses ${c.name} on the statement's own row`, () => {
        const made = flange(c.write);
        const scene = render();
        const refused = made.statement;

        expect(refused.getError()).toBe(c.message);
        expect(scene.getRenderedObject(refused)!.errorMessage).toBe(c.message);
        expect(errors(scene)).toEqual([`${refused.getUniqueType()}: ${c.message}`]);
        // The refused statement made nothing: no copies under it, no solids.
        expect(refused.getChildren()).toEqual([]);
        expect(refused.getShapes()).toEqual([]);
        expect(made.plate.getShapes().filter(s => s.getType() === "solid")).toHaveLength(1);
      });
    }

    it("keeps the first statement's family when a second one is refused", () => {
      let first: SceneObject | null = null;
      const made = flange(bolt => {
        first = copy("linear", "x", { count: 2, offset: 20 }, bolt) as unknown as SceneObject;
        return copy("linear", "y", { count: 3, offset: 20 }, bolt);
      });
      first!;
      render();
      expect(made.bolt.getFamily()!.statement).toBe(first);
      near(frameOf(made.bolt.instance(1)).origin, 50, 0, 10);
    });

    it("refuses a connector inside a sketch on the sketch's copy", () => {
      let inSketch: SceneObject | null = null;
      const made = flange(bolt => {
        sketch("xy", () => {
          testRect(10, 10, { at: [200, 200] });
          inSketch = copy("linear", "x", { count: 2, offset: 20 }, bolt) as unknown as SceneObject;
        });
        return null;
      });
      const scene = render();
      const message = "copy(): connectors aren't copied inside a sketch — copy bolt in the part body, outside sketch()";
      expect(inSketch!.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${inSketch!.getUniqueType()}: ${message}`]);
      expect(made.bolt.getFamily()).toBeNull();
    });

    it("refuses another part's connector — a part's connectors are copied in its own body", () => {
      const donor = flange(() => null, "donor");
      let stolen: SceneObject | null = null;
      part("thief", () => {
        sketch("xy", () => {
          testRect(10, 10);
        });
        extrude(5);
        stolen = copy("linear", "x", { count: 2, offset: 20 }, donor.bolt) as unknown as SceneObject;
      });
      const scene = render();
      const message = `copy(): bolt belongs to part "donor" — a part's connectors are copied inside that part's body`;
      expect(stolen!.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${stolen!.getUniqueType()}: ${message}`]);
      expect(donor.bolt.getFamily()).toBeNull();
    });

    it("refuses a connector copied at a file's top level", () => {
      const def = part("flange", () => {
        sketch("xy", () => {
          testRect(100, 100, { at: [-50, -50] });
        });
        extrude(10);
        connector("bolt", select(face().planar().onPlane("xy", 10)));
      }) as unknown as PartDefinition;
      const bolt = def.getNamedConnectors().bolt;
      const statement = copy("linear", "x", { count: 2, offset: 20 }, bolt) as unknown as SceneObject;
      const scene = render();
      const message = `copy(): bolt belongs to part "flange" — a part's connectors are copied inside that part's body`;
      expect(statement.getError()).toBe(message);
      expect(errors(scene)).toEqual([`${statement.getUniqueType()}: ${message}`]);
    });

    it("keeps a refusal across a cached render, and drops it once the statement is fixed", () => {
      const manager = getSceneManager();
      const author = (centered: boolean) =>
        flange(bolt => copy("circular", "z", { count: 4, angle: 360, centered }, bolt));
      const refusal = "copy(): a circular copy of a connector can't be centered yet — drop centered; "
        + "the pattern then starts at the connector";

      author(true);
      render();
      const firstScene = manager.currentScene;

      const again = manager.startScene();
      const second = author(true);
      again.materializeLeftoverDefinitions();
      SceneCompare.compare(firstScene, again);
      expect(again.isCached(second.statement)).toBe(true);
      render();
      expect(second.statement.getError()).toBe(refusal);

      const fixed = manager.startScene();
      const third = author(false);
      fixed.materializeLeftoverDefinitions();
      SceneCompare.compare(again, fixed);
      expect(fixed.isCached(third.statement)).toBe(false);
      const scene = render();
      expect(errors(scene)).toEqual([]);
      expect(copiesIn(scene)).toHaveLength(3);
    });
  });

  describe("the part's registries", () => {
    it("lists every frame, but names and uniqueness only the declared connectors", () => {
      let top: Connector | null = null;
      const made = flange(bolt => {
        const statement = copy("linear", "x", { count: 3, offset: 20 }, bolt);
        top = connector("top", select(face().planar().onPlane("xy", 10))) as unknown as Connector;
        return statement;
      });
      const scene = render();
      expect(errors(scene)).toEqual([]);

      const flangePart = made.bolt.getParent() as Part;
      const copies = copiesIn(scene);
      expect(flangePart.getDeclaredConnectors()).toEqual([made.bolt, top]);
      expect(flangePart.getConnectors()).toEqual([made.bolt, ...copies, top]);
      expect(Object.keys(flangePart.getNamedConnectors())).toEqual(["bolt", "top"]);

      expect(flangePart.resolveConnector("bolt")).toBe(made.bolt);
      expect(flangePart.resolveConnector("bolt", 0)).toBe(made.bolt);
      expect(flangePart.resolveConnector("bolt", 2)).toBe(copies[1]);
      expect(flangePart.resolveConnector("bolt", 3)).toBeNull();
      expect(flangePart.resolveConnector("top", 1)).toBeNull();
      expect(flangePart.resolveConnector("constructor")).toBeNull();

      // Declaring the name again still clashes with the seed, copies or not.
      expect(() => part("again", () => {
        sketch("xy", () => {
          testRect(10, 10);
        });
        extrude(5);
        const bolt = connector("bolt", select(face().planar().onPlane("xy", 5)));
        copy("linear", "x", { count: 2, offset: 20 }, bolt);
        connector("bolt", select(face().planar().onPlane("xy", 0)));
      }).materialize()).toThrow(`the part "again" already has a connector named "bolt"`);
    });

    it("re-picking a copied seed under its own name is not a clash with its copies", () => {
      const made = flange(bolt => copy("circular", "z", { count: 4, angle: 360 }, bolt));
      const scene = render();
      expect(errors(scene)).toEqual([]);
      // Synthesis anchors the edit on the producers' statements.
      setLocation(made.bolt.getParent(), 2);
      setLocation(made.plate, 6);
      const solid = findSolid(scene);
      const tops = faceRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
      expect(tops).toHaveLength(1);

      const scoped = scopedSceneBefore(scene, scene.getTimelineObjects().indexOf(made.bolt));
      expect(scoped.editedStatement).toBe(made.bolt);
      const kept = synthesizeApplyFeature(scoped, tops, "connector", "bolt");
      expect(kept.ok).toBe(true);
    });
  });

  it("gives each copy its seed's host, so hiding the body hides the copies", () => {
    const made = flange(bolt => copy("circular", "z", { count: 3, angle: 360 }, bolt));
    const scene = render();
    expect(errors(scene)).toEqual([]);

    const hostIds = scene.getRenderedObject(made.bolt)!.object.hostShapeIds;
    expect(hostIds).toEqual(made.plate.getShapes().map(s => s.id));
    const copies = copiesIn(scene);
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      expect(c.getHostShape()).toBe(made.bolt.getHostShape());
      expect(scene.getRenderedObject(c)!.object.hostShapeIds).toEqual(hostIds);
    }
  });

  it("rebuilds copies when the count changes and reuses them on an unchanged render", () => {
    const manager = getSceneManager();
    const author = (count: number) => flange(bolt => copy("circular", "z", { count, angle: 360 }, bolt));

    const first = author(6);
    render();
    const firstScene = manager.currentScene;
    const firstIds = [1, 2, 3, 4, 5].map(k => first.bolt.instance(k).id);

    const again = manager.startScene();
    const second = author(6);
    again.materializeLeftoverDefinitions();
    SceneCompare.compare(firstScene, again);
    const cached = copiesIn(again);
    expect(cached.map(c => again.isCached(c))).toEqual([true, true, true, true, true]);
    let scene = render();
    expect(errors(scene)).toEqual([]);
    expect(cached.map(c => c.id)).toEqual(firstIds);
    near(frameOf(second.bolt.instance(1)).origin, 15, 30 * Math.sin(Math.PI / 3), 10);

    const changed = manager.startScene();
    const third = author(8);
    changed.materializeLeftoverDefinitions();
    SceneCompare.compare(again, changed);
    expect(changed.isCached(third.statement)).toBe(false);
    expect(copiesIn(changed).some(c => changed.isCached(c))).toBe(false);
    scene = render();
    expect(errors(scene)).toEqual([]);
    expect(copiesIn(scene)).toHaveLength(7);
    near(frameOf(third.bolt.instance(2)).origin, 0, 30, 10);
  });
});

// ---------------------------------------------------------------------------
// D7: a connector is also an axis — `copy()` walks along or turns around its
// Z axis through its origin, beside world axes, axis() features and edges.
// ---------------------------------------------------------------------------

describe("a connector as the copy axis", () => {
  setupOC();

  /** A second connector on the plate's top face, 20 to the -X side: Z up through (-20, 0). */
  function pivotOnTop(): Connector {
    return (connector("pivot", select(face().planar().onPlane("xy", 10))) as unknown as Connector).offset(-20, 0, 0);
  }

  it("turns a connector copy around another connector's Z axis", () => {
    const made = flange(bolt => copy("circular", pivotOnTop(), { count: 4, angle: 360 }, bolt));
    const scene = render();
    expect(errors(scene)).toEqual([]);

    // The bolt (30, 0) sits 50 out from the pivot's axis at (-20, 0).
    near(frameOf(made.bolt.instance(1)).origin, -20, 50, 10);
    near(frameOf(made.bolt.instance(2)).origin, -70, 0, 10);
    near(frameOf(made.bolt.instance(3)).origin, -20, -50, 10);
    near(frameOf(made.bolt.instance(1)).xDirection, 0, 1, 0);
    near(frameOf(made.bolt.instance(1)).normal, 0, 0, 1);
  });

  it("walks a linear copy along a tilted connector's Z, not the world's", () => {
    let pivot: Connector | null = null;
    const made = flange(bolt => {
      pivot = pivotOnTop().rotate("x", 90);
      return copy("linear", pivot, { count: 3, offset: 20 }, bolt);
    });
    const scene = render();
    expect(errors(scene)).toEqual([]);

    const along = frameOf(pivot!).normal;
    expect(Math.abs(along.z)).toBeLessThan(1e-9);
    for (const slot of [1, 2]) {
      near(frameOf(made.bolt.instance(slot)).origin, 30 + along.x * 20 * slot, along.y * 20 * slot, 10);
    }
  });

  it("copies a solid around the connector's axis", () => {
    let box: SceneObject | null = null;
    flange(() => {
      sketch("xy", () => {
        testRect(10, 10, { at: [40, -5] });
      });
      box = extrude(5).new() as unknown as SceneObject;
      return copy("circular", pivotOnTop(), { count: 2, angle: 360 }, box as never);
    });
    const scene = render();
    expect(errors(scene)).toEqual([]);

    // Half a turn around (-20, 0): x → -40 - x, so [40, 50] lands on [-90, -80].
    const statement = scene.getAllSceneObjects().find(o => o instanceof CopyBase)!;
    const turned = statement.getShapes()
      .map(shape => ShapeOps.getBoundingBox(shape))
      .find(bbox => bbox.minX < 0)!;
    expect(turned.minX).toBeCloseTo(-90, 6);
    expect(turned.maxX).toBeCloseTo(-80, 6);
    expect(turned.minY).toBeCloseTo(-5, 6);
  });

  it("takes a connector copy as the axis — bolt.instance(k)", () => {
    let pin: Connector | null = null;
    const made = flange(bolt => {
      copy("linear", "x", { count: 2, offset: 40 }, bolt);
      pin = pivotOnTop();
      return copy("circular", bolt.instance(1), { count: 2, angle: 360 }, pin);
    });
    const scene = render();
    expect(errors(scene)).toEqual([]);

    // Half a turn around bolt.instance(1) at (70, 0): the pin at (-20, 0) lands on (160, 0).
    near(frameOf(made.bolt.instance(1)).origin, 70, 0, 10);
    near(frameOf(pin!.instance(1)).origin, 160, 0, 10);
  });

  it("reuses the statement on an unchanged render and follows the axis connector when it moves", () => {
    const manager = getSceneManager();
    const author = (dx: number) => flange(bolt => {
      const pivot = (connector("pivot", select(face().planar().onPlane("xy", 10))) as unknown as Connector)
        .offset(dx, 0, 0);
      return copy("circular", pivot, { count: 2, angle: 360 }, bolt);
    });

    author(-20);
    render();
    const firstScene = manager.currentScene;

    const again = manager.startScene();
    const second = author(-20);
    again.materializeLeftoverDefinitions();
    SceneCompare.compare(firstScene, again);
    expect(again.isCached(second.statement)).toBe(true);
    let scene = render();
    expect(errors(scene)).toEqual([]);
    near(frameOf(second.bolt.instance(1)).origin, -70, 0, 10);

    const moved = manager.startScene();
    const third = author(0);
    moved.materializeLeftoverDefinitions();
    SceneCompare.compare(again, moved);
    expect(moved.isCached(third.statement)).toBe(false);
    scene = render();
    expect(errors(scene)).toEqual([]);
    near(frameOf(third.bolt.instance(1)).origin, -30, 0, 10);
  });

  it("reports an axis connector that did not build on the copies it would place", () => {
    const made = flange(bolt => {
      const lost = connector("lost", select(face().planar().onPlane("xy", 99)));
      return copy("circular", lost, { count: 2, angle: 360 }, bolt);
    });
    render();

    expect(made.bolt.instance(1).getError()).toBe(
      "copy(): lost did not build, so it gives no axis to copy along",
    );
  });

  it("refuses an inserted instance's connector as the axis", () => {
    const seed = new Connector("bolt", new FreePoint(new Point(0, 0, 0)));
    const bound = new BoundConnector(seed, "i1");
    expect(ConnectorCopyRules.boundAxis(["z", bound])).toBe(
      "copy(): instance.connectors.bolt belongs to an inserted instance — its pose is the "
        + "assembly solver's, so it can't be a copy axis",
    );
    expect(ConnectorCopyRules.boundAxis(["z", seed])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Foreign units: the definition lives in its own inch file (sourceURL), so
// the unit registry can give it a unit different from the consuming scene's.
// ---------------------------------------------------------------------------

const INCH_FLANGE_FILE = "/ws/fixtures/inch-flange.fluid.js";

/** A 2 × 2 × 0.5 in plate with `bolt` 0.75 in out along X on its top, copied four times around Z. */
function defineInchFlange(): PartDefinition {
  const source = `
    return part('InchFlange', () => {
      sketch('xy', () => {
        testRect(2, 2, { at: [-1, -1] });
      });
      const e = extrude(0.5);
      const bolt = connector('bolt', e.endFaces()).offset(0.75, 0, 0);
      copy('circular', 'z', { count: 4, angle: 360 }, bolt);
    });
    //# sourceURL=${INCH_FLANGE_FILE}
  `;
  const globals: Record<string, unknown> = { ...core, ...filters, ...constraints, testRect };
  const names = Object.keys(globals);
  const fn = new Function(...names, `"use strict";\n${source}`);
  return fn(...names.map(n => globals[n])) as PartDefinition;
}

describe("connector copies in a foreign-unit part", () => {
  setupOC();

  afterEach(() => {
    getSceneManager().projectUnit = "mm";
  });

  it("rescales the copies with the rest of the part", () => {
    getSceneManager().projectUnit = "mm";
    const scene = getSceneManager().startAssemblyScene();
    getUnitRegistry().declare(INCH_FLANGE_FILE, "in");
    const inst = insert(defineInchFlange());
    render();
    expect(errors(scene)).toEqual([]);

    const bolt = inst.connectors.bolt;
    near(bolt.getFrame().origin, 19.05, 0, 12.7);
    near(bolt.instance(1).getFrame().origin, 0, 19.05, 12.7);
    near(bolt.instance(2).getFrame().origin, -19.05, 0, 12.7);
    const copy1 = bolt.instance(1).connector;
    expect(copy1).toBeInstanceOf(ConnectorCopy);
    expect(scene.findEnclosingPart(copy1)).toBe(inst.record.part);
    expect(copy1.getUnit()).toBe("mm");
  });
});

// ---------------------------------------------------------------------------
// Assemblies: copies are ordinary mate sides and replicate cells.
// ---------------------------------------------------------------------------

function buildFlange(): PartDefinition {
  return part("flange", () => {
    sketch("xy", () => {
      testRect(100, 100, { at: [-50, -50] });
    });
    extrude(10);
    const bolt = connector("bolt", select(face().planar().onPlane("xy", 10))).offset(30, 0, 0);
    copy("circular", "z", { count: 6, angle: 360 }, bolt);
  }) as unknown as PartDefinition;
}

function buildPin(): PartDefinition {
  return part("pin", () => {
    sketch("xy", () => {
      testRect(4, 4, { at: [-2, -2] });
    });
    extrude(20);
    connector("head", select(face().planar().onPlane("xy", 0)));
  }) as unknown as PartDefinition;
}

function buildRail(): PartDefinition {
  return part("rail", () => {
    sketch("xy", () => {
      testRect(200, 20, { at: [-100, -10] });
    });
    extrude(10);
    connector("s1", select(face().planar().onPlane("xy", 10))).offset(-60, 0, 0);
    connector("s2", select(face().planar().onPlane("xy", 10)));
    connector("s3", select(face().planar().onPlane("xy", 10))).offset(60, 0, 0);
  }) as unknown as PartDefinition;
}

function startAssembly(): { flangeDef: PartDefinition; pinDef: PartDefinition; railDef: PartDefinition; scene: AssemblyScene } {
  getSceneManager().startScene();
  const flangeDef = buildFlange();
  const pinDef = buildPin();
  const railDef = buildRail();
  const scene = getSceneManager().startAssemblyScene();
  return { flangeDef, pinDef, railDef, scene };
}

describe("connector copies in an assembly", () => {
  setupOC();

  it("mates to f.connectors.bolt.instance(3), serializing the copy's id", () => {
    const { flangeDef, pinDef, scene } = startAssembly();
    const f = insert(flangeDef).grounded();
    const b = insert(pinDef);
    mate("fastened", f.connectors.bolt.instance(3), b.connectors.head);
    getSceneManager().renderScene(scene);
    expect(errors(scene)).toEqual([]);

    // Only the declared name is on the instance; the copy hangs off it.
    expect(Object.keys(f.connectors)).toEqual(["bolt"]);
    const copy3 = f.record.part.resolveConnector("bolt", 3)!;
    expect(copy3).toBeInstanceOf(ConnectorCopy);
    const [serialized] = scene.getSerializedMates();
    expect(serialized.connectorA).toEqual({ instanceId: f.record.instanceId, connectorId: copy3.id });
    const row = scene.getRenderedObject(copy3)!;
    expect(row.id).toBe(copy3.id);
    expect(row.object.copy).toEqual({ slot: 3, seedId: f.connectors.bolt.connector.id });
    near(row.object.origin, -30, 0, 10);

    // The seed's own slot is the seed: writes plain f.connectors.bolt.
    expect(f.connectors.bolt.instance(0).connector).toBe(f.connectors.bolt.connector);
    expect(() => f.connectors.bolt.instance(6)).toThrow("bolt.instance(6) is out of range");
  });

  it("an assembly-level copy() of an instance's connector is refused on its own row", () => {
    const { flangeDef, scene } = startAssembly();
    const f = insert(flangeDef).grounded();
    const statement = copy("linear", "x", { count: 2, offset: 10 }, f.connectors.bolt as any) as unknown as SceneObject;
    getSceneManager().renderScene(scene);

    const message = "copy(): instance.connectors.bolt belongs to an inserted instance — copy bolt inside its part's body";
    expect(statement.getError()).toBe(message);
    expect(errors(scene)).toEqual([`${statement.getUniqueType()}: ${message}`]);
    expect(f.connectors.bolt.connector.getFamily()?.getCopies()).toHaveLength(5);
  });

  it("refuses an inserted instance's connector handed to copy() inside a part body", () => {
    const { flangeDef, scene } = startAssembly();
    const f = insert(flangeDef).grounded();
    let statement: SceneObject | null = null;
    const other = part("other", () => {
      sketch("xy", () => {
        testRect(10, 10);
      });
      extrude(5);
      statement = copy("linear", "x", { count: 2, offset: 10 }, f.connectors.bolt as any) as unknown as SceneObject;
    });
    insert(other);
    getSceneManager().renderScene(scene);
    const message = "copy(): instance.connectors.bolt belongs to an inserted instance — copy bolt inside its part's body";
    expect(statement!.getError()).toBe(message);
    expect(errors(scene)).toEqual([`${statement!.getUniqueType()}: ${message}`]);
  });

  it("replicates onto copy cells and labels copies in its messages", () => {
    const { flangeDef, pinDef, scene } = startAssembly();
    const f = insert(flangeDef).grounded();
    const b = insert(pinDef);
    mate("fastened", b.connectors.head, f.connectors.bolt);

    const bolt = f.connectors.bolt;
    const replicas = replicate(b, [bolt], [[bolt.instance(1)], [bolt.instance(2)]]);
    expect(replicas).toHaveLength(2);
    const mates = scene.getMates();
    expect(mates).toHaveLength(3);
    expect(mates[1].connectorB).toEqual({ instanceId: f.record.instanceId, connector: bolt.instance(1).connector });
    expect(mates[2].connectorB).toEqual({ instanceId: f.record.instanceId, connector: bolt.instance(2).connector });
    const [record] = scene.getSerializedReplicates();
    expect(record.rows).toEqual([
      [{ kind: "connector", instanceId: f.record.instanceId, connectorId: bolt.instance(1).connector.id }],
      [{ kind: "connector", instanceId: f.record.instanceId, connectorId: bolt.instance(2).connector.id }],
    ]);
    getSceneManager().renderScene(scene);
    expect(errors(scene)).toEqual([]);

    // A column must be one of the seed's targets — named by its label.
    expect(() => replicate(b, [bolt.instance(4)], [[bolt.instance(5)]]))
      .toThrow(`replicate(): flange.bolt.instance(4) is not a mate target of "pin" — its targets are: flange.bolt.`);
  });

  it("rebinds a replica's own mate on its part's copy by slot", () => {
    const { flangeDef, railDef, scene } = startAssembly();
    const base = insert(railDef).grounded();
    const f = insert(flangeDef);
    mate("fastened", f.connectors.bolt.instance(2), base.connectors.s1);

    replicate(f, [base.connectors.s1], [[base.connectors.s2]]);
    const mates = scene.getMates();
    expect(mates).toHaveLength(2);
    const replicaId = scene.getInstances()[2].instanceId;
    const inner = mates[1].connectorA!;
    expect(inner.instanceId).toBe(replicaId);
    expect(inner.connector.copySlot()).toBe(2);
    expect(inner.connector).toBe(scene.getInstance(replicaId)!.part.resolveConnector("bolt", 2));
    expect(inner.connector).not.toBe(f.connectors.bolt.connector);
    getSceneManager().renderScene(scene);
    expect(errors(scene)).toEqual([]);
  });
});
