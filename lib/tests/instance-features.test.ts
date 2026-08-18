import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import param from "../core/param.js";
import expose from "../core/expose.js";
import insert from "../core/insert.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { BoundExposure, Exposed } from "../features/exposed.js";

function makeDonorDef() {
  return part("Donor", () => {
    const h = param("Height", 10);
    sketch("xy", () => rect(40, 20));
    extrude(h);
    expose("top", select(face().planar().onPlane("xy", h)));
  });
}

describe("instance.features", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("binds each exposure to the inserted instance", () => {
    getSceneManager().startScene();
    const def = makeDonorDef();
    getSceneManager().startAssemblyScene();
    const a = insert(def);
    const b = insert(def);

    const boundA = a.features.top;
    const boundB = b.features.top;
    expect(boundA).toBeInstanceOf(BoundExposure);
    expect(boundA.exposed).toBeInstanceOf(Exposed);
    expect(boundA.exposed.exposeName).toBe("top");
    // Two instances of one def are distinguished by instanceId — the
    // shapeId-ambiguity gap the expose research found.
    expect(boundA.instanceId).toBe(a.record.instanceId);
    expect(boundB.instanceId).toBe(b.record.instanceId);
    expect(boundA.instanceId).not.toBe(boundB.instanceId);
    // Same template — same live Exposed object.
    expect(boundA.exposed).toBe(boundB.exposed);
  });

  it("serves the materialized variant's exposure under insert(def, {params})", () => {
    getSceneManager().startScene();
    const def = makeDonorDef();
    getSceneManager().startAssemblyScene();
    const plain = insert(def);
    const tall = insert(def, { Height: 25 });

    // Distinct variants materialize distinct parts, so the bound exposures
    // must come from each instance's own variant — not the default one.
    expect(plain.record.part).not.toBe(tall.record.part);
    expect(plain.features.top.exposed).not.toBe(tall.features.top.exposed);
    expect(plain.record.part.getExposed()).toContain(plain.features.top.exposed);
    expect(tall.record.part.getExposed()).toContain(tall.features.top.exposed);
  });

  it("stays distinct from def.features (source SceneObject, default variant)", () => {
    getSceneManager().startScene();
    const def = makeDonorDef();
    getSceneManager().startAssemblyScene();
    const a = insert(def);

    // def-level: the SOURCE scene object (authoring-frame cross-part refs).
    const defLevel = def.features.top;
    expect(defLevel).not.toBeInstanceOf(BoundExposure);
    // instance-level: the bound exposure wrapper.
    expect(a.features.top).toBeInstanceOf(BoundExposure);
    expect(a.features.top.exposed.source).toBeDefined();
  });

  it("is empty for parts with no exposures", () => {
    getSceneManager().startScene();
    const def = part("bare", () => {
      sketch("xy", () => rect(10, 10));
      extrude(5);
    });
    getSceneManager().startAssemblyScene();
    const a = insert(def);
    expect(Object.keys(a.features)).toEqual([]);
  });
});
