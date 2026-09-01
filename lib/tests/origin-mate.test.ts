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
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { AssemblyOriginFrame } from "../features/origin-frame.js";

// `origin(axis?)` at assembly top level: the assembly's own frame as a
// mate side — a base part keeps DOF relative to the world instead of
// being fully pinned by `.grounded()`. Serializes as frameA/frameB
// { axis } sides that the UI solver pins on a synthetic world body.

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

describe("origin() as a mate side", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("origin() in an assembly scene returns the identity frame", () => {
    startAssembly();
    const frame = origin() as unknown;
    expect(frame).toBeInstanceOf(AssemblyOriginFrame);
    expect((frame as AssemblyOriginFrame).axis).toBe("z");
  });

  it("origin('x') / origin('y') carry their axis", () => {
    startAssembly();
    expect(origin("x").axis).toBe("x");
    expect(origin("y").axis).toBe("y");
  });

  it("a custom frame object is rejected with the deferred-feature error", () => {
    startAssembly();
    expect(() => origin({ z: [1, 1, 0] } as any)).toThrow(/not supported yet/i);
  });

  it("an unknown axis is rejected", () => {
    startAssembly();
    expect(() => origin("w" as any)).toThrow(/expected a world axis/i);
  });

  it("mate to origin() records a frame side and serializes its axis", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    mate("revolute", origin(), a.connectors.top);
    const mates = scene.getSerializedMates();
    expect(mates).toHaveLength(1);
    expect(mates[0].frameA).toEqual({ axis: "z" });
    expect(mates[0].connectorA).toBeUndefined();
    expect(mates[0].connectorB?.instanceId).toBe(a.record.instanceId);
    expect(mates[0].frameB).toBeUndefined();
  });

  it("the origin can fill either side, with a non-default axis", () => {
    const { p, scene } = startAssembly();
    const a = insert(p);
    mate("slider", a.connectors.top, origin("x"));
    const mates = scene.getSerializedMates();
    expect(mates[0].connectorA?.instanceId).toBe(a.record.instanceId);
    expect(mates[0].frameB).toEqual({ axis: "x" });
  });

  it("origin mated to origin throws", () => {
    startAssembly();
    expect(() => mate("fastened", origin(), origin("x"))).toThrow(
      /both sides are the assembly origin/i,
    );
  });

  it("tangent to the origin throws", () => {
    const { p } = startAssembly();
    const a = insert(p);
    expect(() => mate("tangent", origin() as any, a.connectors.top as any)).toThrow(
      /no surface to touch/i,
    );
  });

  it("origin() inside an assembly() body is rejected loudly", () => {
    const { p } = startAssembly();
    const def = assembly("sub", () => {
      const a = insert(p);
      expect(() => origin()).toThrow(/not supported yet/i);
      return { a };
    });
    insert(def);
  });

  it("a root-scope origin frame leaking into an assembly() body is rejected at mate()", () => {
    const { p } = startAssembly();
    const rootFrame = origin();
    const def = assembly("sub", () => {
      const a = insert(p);
      expect(() => mate("revolute", rootFrame, a.connectors.top)).toThrow(
        /root-scope only/i,
      );
      return { a };
    });
    insert(def);
  });

  it("origin() inside a part() block still means the sketch datum path", () => {
    getSceneManager().startScene();
    // In part design origin() is the constraint-sketch datum accessor —
    // no assembly dispatch. It must not return an AssemblyOriginFrame.
    part("housing", () => {
      sketch("xy", () => {
        testRect(20, 20);
        expect(origin()).not.toBeInstanceOf(AssemblyOriginFrame);
      });
      extrude(10);
    });
  });
});
