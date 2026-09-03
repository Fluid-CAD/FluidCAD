import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import assembly from "../core/assembly.js";
import { origin } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { Connector } from "../features/connector.js";
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
