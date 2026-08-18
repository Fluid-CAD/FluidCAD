import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import expose from "../core/expose.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { BoundExposure, Exposed } from "../features/exposed.js";
import { MateBuilder, makeTangentAssemblyMate } from "../features/mate.js";

function buildHousing(name = "housing"): Part {
  return part(name, () => {
    sketch("xy", () => rect(20, 20));
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
    connector("bottom", select(face().planar().onPlane("xy", 0)));
  }) as unknown as Part;
}

function startAssembly(): { p: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const p = buildHousing();
  const scene = getSceneManager().startAssemblyScene();
  return { p, scene };
}

describe("mate scope and validation", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("mate() outside an assembly scene throws", () => {
    expect(() => mate("fastened", null as any, null as any)).toThrow(/assembly\.js/i);
  });

  it("mate() with unknown type throws", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("not-a-real-mate" as any, a.connectors.top, b.connectors.top),
    ).toThrow(/unknown mate type/i);
  });

  it("mate() with non-connector arguments throws", () => {
    startAssembly();
    expect(() => mate("fastened", "nope" as any, "nope" as any)).toThrow(/connector/i);
  });

  it("mate() across two instances records the connector refs in source order", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    const builder = mate("fastened", a.connectors.top, b.connectors.top);
    expect(builder).toBeDefined();
    const mates = scene.getMates();
    expect(mates).toHaveLength(1);
    expect(mates[0].type).toBe("fastened");
    expect(mates[0].connectorA.instanceId).toBe(a.record.instanceId);
    expect(mates[0].connectorB.instanceId).toBe(b.record.instanceId);
    // Live Connector refs (not snapshotted ids) — see AssemblyMate docs.
    expect(mates[0].connectorA.connector).toBe(a.connectors.top.connector);
    expect(mates[0].connectorB.connector).toBe(b.connectors.top.connector);
  });

  it("self-referencing mate throws", () => {
    const { p } = startAssembly();
    const a = insert(p);
    expect(() => mate("fastened", a.connectors.top, a.connectors.top)).toThrow(
      /cannot be mated to itself/i,
    );
  });

  it("mate options chain (.flip, .rotate, .offset) record on the mate", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("fastened", a.connectors.top, b.connectors.top)
      .flip()
      .rotate(45)
      .offset(1, 2, 3);
    const m = scene.getMates()[0];
    expect(m.options?.flip).toBe(true);
    expect(m.options?.rotate).toBe(45);
    expect(m.options?.offset).toEqual([1, 2, 3]);
  });

  it("rotate() accumulates across calls", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("fastened", a.connectors.top, b.connectors.top).rotate(30).rotate(60);
    expect(scene.getMates()[0].options?.rotate).toBe(90);
  });

  it("flip() toggles", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("fastened", a.connectors.top, b.connectors.top).flip().flip();
    expect(scene.getMates()[0].options?.flip).toBe(false);
  });

  it("slider mate rejects XY offsets", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("slider", a.connectors.top, b.connectors.top).offset(1, 0, 0),
    ).toThrow(/along Z/i);
    const c = insert(p);
    const d = insert(p);
    expect(() =>
      mate("slider", c.connectors.top, d.connectors.top).offset(0, 2, 5),
    ).toThrow(/along Z/i);
  });

  it("slider mate accepts Z-only offsets", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("slider", a.connectors.top, b.connectors.top).offset(0, 0, 5);
    expect(scene.getMates()[0].options?.offset).toEqual([0, 0, 5]);
  });

  it("cylindrical mate rejects XY offsets", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("cylindrical", a.connectors.top, b.connectors.top).offset(1, 0, 0),
    ).toThrow(/along Z/i);
    const c = insert(p);
    const d = insert(p);
    expect(() =>
      mate("cylindrical", c.connectors.top, d.connectors.top).offset(0, 2, 5),
    ).toThrow(/along Z/i);
  });

  it("cylindrical mate accepts Z-only offsets", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("cylindrical", a.connectors.top, b.connectors.top).offset(0, 0, 5);
    expect(scene.getMates()[0].options?.offset).toEqual([0, 0, 5]);
  });

  it("planar mate rejects XY offsets", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("planar", a.connectors.top, b.connectors.top).offset(1, 0, 0),
    ).toThrow(/along Z/i);
    const c = insert(p);
    const d = insert(p);
    expect(() =>
      mate("planar", c.connectors.top, d.connectors.top).offset(0, 2, 5),
    ).toThrow(/along Z/i);
  });

  it("planar mate accepts Z-only offsets", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("planar", a.connectors.top, b.connectors.top).offset(0, 0, 5);
    expect(scene.getMates()[0].options?.offset).toEqual([0, 0, 5]);
  });

  it("slider mate records .limits", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("slider", a.connectors.top, b.connectors.top).limits(0, 50);
    expect(scene.getMates()[0].options?.limits).toEqual([0, 50]);
  });

  it("revolute mate records .limits", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    mate("revolute", a.connectors.top, b.connectors.top).limits(-90, 90);
    expect(scene.getMates()[0].options?.limits).toEqual([-90, 90]);
  });

  it(".limits on a non-slider/revolute mate throws", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("fastened", a.connectors.top, b.connectors.top).limits(0, 10),
    ).toThrow(/only supported on/i);
    const c = insert(p);
    const d = insert(p);
    expect(() =>
      mate("cylindrical", c.connectors.top, d.connectors.top).limits(0, 10),
    ).toThrow(/only supported on/i);
  });

  it(".limits requires min strictly less than max", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("slider", a.connectors.top, b.connectors.top).limits(10, 10),
    ).toThrow(/strictly less than/i);
    const c = insert(p);
    const d = insert(p);
    expect(() =>
      mate("revolute", c.connectors.top, d.connectors.top).limits(20, 5),
    ).toThrow(/strictly less than/i);
  });

  it(".limits rejects non-finite bounds", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("slider", a.connectors.top, b.connectors.top).limits(0, Infinity),
    ).toThrow(/finite/i);
  });
});

describe("tangent mate (parse gate + record shape)", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  // Hand-built record: the mate() parse gate stays closed until the solver
  // phase lands, but the record path and builder guards are live. Sources
  // are built in the part scene BEFORE the assembly starts — sketch() is
  // part-design only.
  function startTangentAssembly() {
    getSceneManager().startScene();
    const srcA = sketch("xy", () => rect(1, 1));
    const srcB = sketch("xy", () => rect(2, 2));
    const scene = getSceneManager().startAssemblyScene();
    const a = new BoundExposure(new Exposed("profile", srcA as never), "inst-0");
    const b = new BoundExposure(new Exposed("tip", srcB as never), "inst-1");
    const record = makeTangentAssemblyMate(a, b, scene.nextMateId(), scene.currentScopePath(), undefined);
    scene.addMate(record);
    return { scene, record };
  }

  it("mate('tangent', …) rejects connector arguments with a pointed error", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("tangent", a.connectors.top, b.connectors.top),
    ).toThrow(/takes exposed geometry, not connectors/i);
  });

  it("mate('tangent', …) with bound exposures records geometry sides", () => {
    getSceneManager().startScene();
    const donor = part("Donor", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      expose("top", select(face().planar().onPlane("xy", 10)));
    });
    const scene = getSceneManager().startAssemblyScene();
    const a = insert(donor);
    const b = insert(donor);
    const builder = mate("tangent", a.features.top, b.features.top);
    expect(builder).toBeDefined();
    const mates = scene.getMates();
    expect(mates).toHaveLength(1);
    expect(mates[0].type).toBe("tangent");
    expect(mates[0].geometryA?.instanceId).toBe(a.record.instanceId);
    expect(mates[0].geometryB?.instanceId).toBe(b.record.instanceId);
    expect(mates[0].connectorA).toBeUndefined();
    // Same def, same exposure — but different instances: allowed.
    expect(mates[0].geometryA?.exposed).toBe(mates[0].geometryB?.exposed);
  });

  it("mate('tangent') on the same instance's same exposure throws", () => {
    getSceneManager().startScene();
    const donor = part("Donor", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      expose("top", select(face().planar().onPlane("xy", 10)));
    });
    getSceneManager().startAssemblyScene();
    const a = insert(donor);
    expect(() => mate("tangent", a.features.top, a.features.top)).toThrow(
      /cannot be mated to itself/i,
    );
  });

  it(".noPropagate() on a non-tangent mate throws", () => {
    const { p } = startAssembly();
    const a = insert(p);
    const b = insert(p);
    expect(() =>
      mate("fastened", a.connectors.top, b.connectors.top).noPropagate(),
    ).toThrow(/only applies to 'tangent'/i);
  });

  it("rejects flip/rotate/offset/limits on a tangent record", () => {
    const { record } = startTangentAssembly();
    const builder = new MateBuilder(record);
    expect(() => builder.flip()).toThrow(/not supported on tangent/i);
    expect(() => builder.rotate(30)).toThrow(/not supported on tangent/i);
    expect(() => builder.offset(0, 0, 5)).toThrow(/not supported on tangent/i);
    expect(() => builder.limits(0, 10)).toThrow(/only supported on/i);
  });

  it(".noPropagate() records propagate: false on a tangent record", () => {
    const { record } = startTangentAssembly();
    new MateBuilder(record).noPropagate();
    expect(record.options?.propagate).toBe(false);
  });

  it("serializes geometry sides (instanceId + exposeName), no connector sides", () => {
    const { scene } = startTangentAssembly();
    const serialized = scene.getSerializedMates();
    expect(serialized).toHaveLength(1);
    const m = serialized[0];
    expect(m.type).toBe("tangent");
    expect(m.connectorA).toBeUndefined();
    expect(m.connectorB).toBeUndefined();
    expect(m.geometryA).toEqual({ instanceId: "inst-0", exposeName: "profile" });
    expect(m.geometryB).toEqual({ instanceId: "inst-1", exposeName: "tip" });
  });

  it("connector mates reject exposed-geometry arguments with a pointed error", () => {
    getSceneManager().startScene();
    const src = sketch("xy", () => rect(1, 1));
    getSceneManager().startAssemblyScene();
    const bound = new BoundExposure(new Exposed("g1", src as never), "inst-0");
    expect(() => mate("fastened", bound, bound)).toThrow(/takes connectors, not exposed geometry/i);
  });
});
