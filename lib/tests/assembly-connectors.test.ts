import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import copy from "../core/copy.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import replicate from "../core/replicate.js";
import assembly from "../core/assembly.js";
import { origin } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { Connector } from "../features/connector.js";
import { ConnectorCopy } from "../features/connector-copy.js";
import { SceneObject } from "../common/scene-object.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";

// `connector('name', [x, y, z])` at assembly top level: a mate frame placed
// freely in the assembly's space, attached to no geometry. It is a mate()
// side in its own right — serialized as frameA/frameB { connectorId } that
// the UI solver pins on a synthetic grounded world body — and the assembly
// payload lists every such connector with its built frame.

function buildHousing(name = "housing"): Part {
  return part(name, () => {
    sketch("xy", () => { testRect(20, 20); });
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
  }) as unknown as Part;
}

function startAssembly(): { p: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const p = buildHousing();
  const scene = getSceneManager().startAssemblyScene();
  return { p, scene };
}

function render(scene: AssemblyScene): void {
  getSceneManager().renderScene(scene);
}

const near = (v: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

/** Every object's build error, readable — `[]` when the render is clean. */
function errors(scene: AssemblyScene): string[] {
  return scene.getAllSceneObjects()
    .filter(o => o.getError())
    .map(o => `${o.getUniqueType()}: ${o.getError()}`);
}

/** A connector() / copy() return value as the scene object it is. */
function asConnector(value: unknown): Connector {
  return value as Connector;
}

describe("connector() at assembly top level", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("returns an assembly connector framed at the point with world axes", () => {
    const { scene } = startAssembly();
    const c = connector("base", [10, 20, 30]) as unknown as Connector;
    expect(c).toBeInstanceOf(Connector);
    expect(c.isAssemblyConnector()).toBe(true);
    expect(c.owner).toBe("");
    render(scene);
    const frame = c.getFrame();
    near(frame.origin, 10, 20, 30);
    near(frame.xDirection, 1, 0, 0);
    near(frame.normal, 0, 0, 1);
    expect(c.getHostShape()).toBeNull();
  });

  it("applies the rotate/offset chain in order about the frame's own axes", () => {
    const { scene } = startAssembly();
    const c = (connector("hinge", [40, 0, 12]) as unknown as Connector).rotate("x", 90);
    const nudged = (connector("shifted", [0, 0, 0]) as unknown as Connector).offset(0, 0, 5).rotate("x", 90);
    render(scene);
    const hinge = c.getFrame();
    near(hinge.origin, 40, 0, 12);
    near(hinge.normal, 0, -1, 0);
    near(hinge.xDirection, 1, 0, 0);
    // Offset first (along the still-world Z), then the rotation pivots at
    // the offset origin — the connector turns in place at z=5.
    const shifted = nudged.getFrame();
    near(shifted.origin, 0, 0, 5);
    near(shifted.normal, 0, -1, 0);
  });

  it("lists connectors in the assembly payload with frames and source", () => {
    const { scene } = startAssembly();
    connector("base", [0, 0, 0]);
    (connector("rail", [0, 0, 0]) as unknown as Connector).rotate("y", 90);
    render(scene);
    const data = getSceneManager().getAssemblyData(scene)!;
    expect(data.connectors.map(c => c.name)).toEqual(["base", "rail"]);
    const rail = data.connectors[1];
    expect(rail.connectorId).toBe(scene.getAssemblyConnectors()[1].id);
    expect(rail.owner).toBe("");
    near(rail.normal, 1, 0, 0);
    near(rail.xDirection, 0, 0, -1);
  });

  it("rejects a point source inside a part, and geometry at assembly level", () => {
    getSceneManager().startScene();
    expect(() => part("p", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(10);
      connector("free", [0, 0, 0] as any);
    }).materialize()).toThrow(/source must be a face\/edge\/vertex selection/);

    const { p } = startAssembly();
    const inst = insert(p);
    expect(() => connector("bad", inst.connectors.top as any)).toThrow(/takes a world point \[x, y, z\]/);
    expect(() => connector("bad", { x: 0, y: 0, z: 0 } as any)).toThrow(/takes a world point \[x, y, z\]/);
    expect(() => connector("bad", [0, 0] as any)).toThrow(/takes a world point \[x, y, z\]/);
  });

  it("rejects bad names and duplicate names within the assembly", () => {
    startAssembly();
    expect(() => connector("not valid", [0, 0, 0])).toThrow(/connector's name/);
    connector("base", [0, 0, 0]);
    expect(() => connector("base", [1, 1, 1])).toThrow(/already has a connector named "base"/);
  });

  it("a part connector and an assembly connector may share a name", () => {
    const { scene } = startAssembly();
    connector("top", [0, 0, 0]);
    render(scene);
    expect(scene.getAssemblyConnectors()).toHaveLength(1);
  });

  it("refuses inside an inserted assembly() body (root scope only)", () => {
    const { p } = startAssembly();
    const sub = assembly("sub", () => {
      const a = insert(p);
      connector("inner", [0, 0, 0]);
      return { a };
    });
    expect(() => insert(sub)).toThrow(/root-scope only/);
  });

  it("origin() is part-design only — no assembly frame meaning", () => {
    startAssembly();
    expect(() => origin()).toThrow(/part-design only/);
  });
});

describe("mate() with an assembly connector side", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("serializes the side as frameA/frameB { connectorId }, read live", () => {
    const { p, scene } = startAssembly();
    const base = connector("base", [0, 0, 0]);
    const inst = insert(p);
    mate("fastened", base, inst.connectors.top);
    mate("revolute", inst.connectors.top, base).rotate(30);
    render(scene);
    const mates = scene.getSerializedMates();
    const baseId = scene.getAssemblyConnectors()[0].id;
    expect(mates[0].frameA).toEqual({ connectorId: baseId });
    expect(mates[0].connectorA).toBeUndefined();
    expect(mates[0].connectorB).toEqual({ instanceId: "inst-0", connectorId: expect.any(String) });
    expect(mates[1].frameB).toEqual({ connectorId: baseId });
    expect(mates[1].frameA).toBeUndefined();
    expect(mates[1].options).toEqual({ rotate: 30 });
  });

  it("rejects two assembly connectors, a bare part connector, and tangent", () => {
    const { p } = startAssembly();
    const a = connector("a", [0, 0, 0]);
    const b = connector("b", [1, 0, 0]);
    const inst = insert(p);
    expect(() => mate("fastened", a, b)).toThrow(/both sides are assembly connectors/);
    const bare = (p as unknown as { getNamedConnectors(): Record<string, Connector> }).getNamedConnectors().top;
    expect(() => mate("fastened", a, bare)).toThrow(/part connector with no instance/);
    expect(() => mate("tangent", a, inst.connectors.top)).toThrow(/takes exposed geometry, not connectors/);
  });

  it("refuses a mate to an assembly connector from inside an assembly() body", () => {
    const { p } = startAssembly();
    const base = connector("base", [0, 0, 0]);
    const sub = assembly("sub", () => {
      const a = insert(p);
      mate("fastened", base, a.connectors.top);
      return { a };
    });
    expect(() => insert(sub)).toThrow(/root-scope only/);
  });
});

// `copy('linear' | 'circular', …, bay)` at assembly top level (connector
// copies stage 3): the assembly's own connectors are copied like a part's —
// each copy a ConnectorCopy of the seed's frame, registered among the
// assembly's connectors, serialized with its slot and seed, and a mate side
// or replicate cell as `bay.instance(k)`. The axis is a world axis or an
// assembly connector's Z axis. Every rule the statement breaks — root scope
// only, assembly connectors only, never an inserted instance's connector —
// refuses it on its own row: a render never throws.

describe("copy() of assembly connectors", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("registers each copy among the assembly's connectors, serialized with its slot and seed", () => {
    const { scene } = startAssembly();
    const bay = asConnector(connector("bay", [0, 0, 20]));
    const statement = copy("linear", "x", { count: 4, offset: 50 }, bay) as unknown as SceneObject;
    render(scene);
    expect(errors(scene)).toEqual([]);

    expect(scene.getAssemblyConnectors().map(c => c.label()))
      .toEqual(["bay", "bay.instance(1)", "bay.instance(2)", "bay.instance(3)"]);
    const copy2 = bay.instance(2);
    expect(copy2).toBeInstanceOf(ConnectorCopy);
    expect(copy2.isAssemblyConnector()).toBe(true);
    expect(copy2.getParent()).toBe(statement);
    near(copy2.getFrame().origin, 100, 0, 20);
    near(copy2.getFrame().xDirection, 1, 0, 0);
    near(copy2.getFrame().normal, 0, 0, 1);
    expect(bay.instance(0)).toBe(bay);

    const data = getSceneManager().getAssemblyData(scene)!;
    expect(data.connectors.map(c => c.name)).toEqual(["bay", "bay", "bay", "bay"]);
    expect(data.connectors.map(c => c.copy)).toEqual([
      undefined,
      { slot: 1, seedId: bay.id },
      { slot: 2, seedId: bay.id },
      { slot: 3, seedId: bay.id },
    ]);
    expect(data.connectors[2].connectorId).toBe(copy2.id);
    near(data.connectors[3].origin, 150, 0, 20);
  });

  it("addresses copies with instance(k), and refuses a slot out of range or a connector nothing copies", () => {
    const { scene } = startAssembly();
    const bay = asConnector(connector("bay", [0, 0, 0]));
    const hinge = asConnector(connector("hinge", [0, 0, 0]));
    copy("linear", "x", { count: 4, offset: 50 }, bay);
    render(scene);
    expect(errors(scene)).toEqual([]);

    expect(() => bay.instance(4)).toThrow("bay.instance(4) is out of range — the copy statement makes instances 0–3");
    expect(() => hinge.instance(1)).toThrow("hinge has no copies — copy it with copy(…) at the assembly's top level");
    // A copy keeps its seed's name: declaring another "bay" still clashes, a fresh name does not.
    expect(() => connector("bay", [1, 1, 1])).toThrow(/already has a connector named "bay"/);
    expect(() => connector("dock", [1, 1, 1])).not.toThrow();
  });

  it("mates to bay.instance(2), serializing the copy's id as the frame side", () => {
    const { p, scene } = startAssembly();
    const bay = asConnector(connector("bay", [0, 0, 20]));
    copy("linear", "x", { count: 4, offset: 50 }, bay);
    const inst = insert(p);
    mate("slider", bay.instance(2), inst.connectors.top);
    render(scene);
    expect(errors(scene)).toEqual([]);

    const [serialized] = scene.getSerializedMates();
    expect(serialized.frameA).toEqual({ connectorId: bay.instance(2).id });
    expect(serialized.connectorB).toEqual({ instanceId: inst.record.instanceId, connectorId: expect.any(String) });
  });

  it("replicates onto copy cells of an assembly connector", () => {
    const { p, scene } = startAssembly();
    const bay = asConnector(connector("bay", [0, 0, 20]));
    copy("linear", "x", { count: 3, offset: 50 }, bay);
    const b = insert(p);
    mate("fastened", bay, b.connectors.top);
    replicate(b, [bay], [[bay.instance(1)], [bay.instance(2)]]);
    render(scene);
    expect(errors(scene)).toEqual([]);

    const [record] = scene.getSerializedReplicates();
    expect(record.targets).toEqual([{ kind: "frame", connectorId: bay.id }]);
    expect(record.rows).toEqual([
      [{ kind: "frame", connectorId: bay.instance(1).id }],
      [{ kind: "frame", connectorId: bay.instance(2).id }],
    ]);
  });

  it("copies around another assembly connector's Z axis", () => {
    const { scene } = startAssembly();
    const bay = asConnector(connector("bay", [30, 0, 0]));
    // Z along world -Y, through the origin.
    const pivot = asConnector(connector("pivot", [0, 0, 0])).rotate("x", 90);
    copy("circular", pivot, { count: 4, angle: 360 }, bay);
    render(scene);
    expect(errors(scene)).toEqual([]);

    near(bay.instance(2).getFrame().origin, -30, 0, 0);
    for (const slot of [1, 3]) {
      const origin = bay.instance(slot).getFrame().origin;
      expect(Math.abs(origin.z)).toBeCloseTo(30, 6);
      expect(origin.x).toBeCloseTo(0, 6);
      expect(origin.y).toBeCloseTo(0, 6);
    }
  });

  it("copies around a copy's Z axis", () => {
    const { scene } = startAssembly();
    const rail = asConnector(connector("rail", [0, 0, 0]));
    copy("linear", "y", { count: 2, offset: 40 }, rail);
    const bay = asConnector(connector("bay", [10, 40, 0]));
    copy("circular", rail.instance(1), { count: 2, angle: 360 }, bay);
    render(scene);
    expect(errors(scene)).toEqual([]);

    // Half a turn about the vertical through rail.instance(1) at (0, 40, 0).
    near(bay.instance(1).getFrame().origin, -10, 40, 0);
  });

  it("refuses a copy() inside an assembly() body — assembly connectors are root-scope only", () => {
    const { p, scene } = startAssembly();
    const bay = asConnector(connector("bay", [0, 0, 0]));
    let statement!: SceneObject;
    const sub = assembly("sub", () => {
      const a = insert(p);
      statement = copy("linear", "x", { count: 2, offset: 10 }, bay) as unknown as SceneObject;
      return { a };
    });
    insert(sub);
    render(scene);

    const message = "copy() inside an assembly() body — assembly connectors are root-scope only for now; "
      + "copy them at the top level of the file that declares them";
    expect(statement.getError()).toBe(message);
    expect(errors(scene)).toEqual([`${statement.getUniqueType()}: ${message}`]);
    expect(bay.getFamily()).toBeNull();
    expect(scene.getAssemblyConnectors()).toEqual([bay]);
  });

  it("refuses an inserted instance's connector as a target and as the axis", () => {
    const { p, scene } = startAssembly();
    const inst = insert(p);
    const bay = asConnector(connector("bay", [0, 0, 0]));
    const asTarget = copy("linear", "x", { count: 2, offset: 10 }, inst.connectors.top as any) as unknown as SceneObject;
    const asAxis = copy("circular", inst.connectors.top as any, { count: 2, angle: 360 }, bay) as unknown as SceneObject;
    render(scene);

    expect(asTarget.getError()).toBe(
      "copy(): instance.connectors.top belongs to an inserted instance — copy top inside its part's body",
    );
    expect(asAxis.getError()).toBe(
      "copy(): instance.connectors.top belongs to an inserted instance — its pose is the assembly solver's, "
        + "so it can't be a copy axis",
    );
    expect(bay.getFamily()).toBeNull();
    expect(scene.getAssemblyConnectors()).toEqual([bay]);
  });

  it("refuses what isn't an assembly connector: no targets, an instance, a part connector, a part connector axis", () => {
    const { p, scene } = startAssembly();
    const inst = insert(p);
    const bay = asConnector(connector("bay", [0, 0, 0]));
    const bare = (p as unknown as { getNamedConnectors(): Record<string, Connector> }).getNamedConnectors().top;
    const statements = [
      copy("linear", "x", { count: 2, offset: 10 }),
      copy("linear", "x", { count: 2, offset: 10 }, inst as any),
      copy("linear", "x", { count: 2, offset: 10 }, bare),
      copy("circular", bare, { count: 2, angle: 360 }, bay),
    ] as unknown as SceneObject[];
    render(scene);

    expect(statements.map(s => s.getError())).toEqual([
      "copy(): at an assembly's top level copy() copies assembly connectors — list the ones to copy, "
        + "e.g. copy('linear', 'x', { count: 3, offset: 20 }, bay)",
      "copy(): at an assembly's top level copy() copies assembly connectors only — got an inserted instance; "
        + "solids are copied inside a part's body",
      "copy(): top is a part connector — copy it inside its part's body",
      "copy(): top is a part connector — an assembly's copy axis is a world axis ('x', 'y', 'z') or an assembly connector",
    ]);
    expect(bay.getFamily()).toBeNull();
    expect(scene.getAssemblyConnectors()).toEqual([bay]);
  });

  it("keeps one copy statement per assembly connector, and never copies a copy", () => {
    const { scene } = startAssembly();
    const bay = asConnector(connector("bay", [0, 0, 0]));
    copy("linear", "x", { count: 3, offset: 10 }, bay);
    const again = copy("circular", "z", { count: 3, angle: 360 }, bay) as unknown as SceneObject;
    const ofCopy = copy("linear", "y", { count: 2, offset: 10 }, bay.instance(1)) as unknown as SceneObject;
    render(scene);

    expect(again.getError()).toBe(
      "copy(): bay is already copied by the copy statement — one copy statement per connector "
        + "(a grid is one two-axis linear copy)",
    );
    expect(ofCopy.getError()).toBe(
      "copy(): bay.instance(1) is itself a copy and isn't copied again — copy bay instead "
        + "(a grid is one two-axis linear copy)",
    );
    expect(scene.getAssemblyConnectors().map(c => c.label())).toEqual(["bay", "bay.instance(1)", "bay.instance(2)"]);
  });
});
