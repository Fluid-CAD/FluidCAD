import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import assembly from "../core/assembly.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import replicate from "../core/replicate.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { AssemblyScene, SerializedInstance } from "../rendering/assembly-scene.js";

// `.transparent(v)` on an insert() handle: a display value carried to the
// assembly view on the serialized instance — 0 opaque, 1 fully transparent.
// It must never touch the pose, the grounding or anything else a solve reads.

function buildBlock(name = "block"): Part {
  return part(name, () => {
    sketch("xy", () => { testRect(20, 20); });
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
    connector("bottom", select(face().planar().onPlane("xy", 0)));
  }) as unknown as Part;
}

function startAssembly(): { block: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const block = buildBlock();
  const scene = getSceneManager().startAssemblyScene();
  return { block, scene };
}

function serialized(scene: AssemblyScene, instanceId: string): SerializedInstance {
  const inst = scene.getSerializedInstances().find(i => i.instanceId === instanceId);
  if (!inst) {
    throw new Error(`no serialized instance ${instanceId}`);
  }
  return inst;
}

describe(".transparent() on inserted parts", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("serializes the value; an untouched instance carries none", () => {
    const { block, scene } = startAssembly();
    insert(block).transparent(0.3);
    insert(block);

    expect(serialized(scene, "inst-0").transparency).toBe(0.3);
    expect("transparency" in serialized(scene, "inst-1")).toBe(false);
  });

  it("defaults to half, the last call wins, and 0 renders opaque", () => {
    const { block, scene } = startAssembly();
    insert(block).transparent();
    insert(block).transparent(0.2).transparent(0.8);
    insert(block).transparent(0.6).transparent(0);

    expect(serialized(scene, "inst-0").transparency).toBe(0.5);
    expect(serialized(scene, "inst-1").transparency).toBe(0.8);
    expect("transparency" in serialized(scene, "inst-2")).toBe(false);
  });

  it("accepts the bounds and refuses anything outside 0..1", () => {
    const { block } = startAssembly();
    expect(() => insert(block).transparent(0)).not.toThrow();
    expect(() => insert(block).transparent(1)).not.toThrow();
    for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => insert(block).transparent(bad)).toThrow(/\.transparent\(\): expected a number from 0 \(opaque\) to 1/);
    }
    expect(() => insert(block).transparent("0.5" as unknown as number)).toThrow(/got string/);
  });

  it("leaves the pose, grounding and name exactly as the chain without it", () => {
    const { block, scene } = startAssembly();
    insert(block).translate(10, 20, 5).rotate("z", 30).grounded().name("plain");
    insert(block).transparent(0.4).translate(10, 20, 5).rotate("z", 30).grounded().name("plain");
    insert(block).translate(10, 20, 5).rotate("z", 30).grounded().name("plain").transparent(0.4);

    const [plain, before, after] = scene.getSerializedInstances();
    for (const inst of [before, after]) {
      expect(inst.position).toEqual(plain.position);
      expect(inst.quaternion).toEqual(plain.quaternion);
      expect(inst.grounded).toBe(plain.grounded);
      expect(inst.name).toBe(plain.name);
      expect(inst.transparency).toBe(0.4);
    }
  });

  it("is per instance: two inserts of one part keep their own values", () => {
    const { block, scene } = startAssembly();
    const a = insert(block).transparent(0.7);
    const b = insert(block);

    expect(a.record.part.id).toBe(b.record.part.id);
    expect(serialized(scene, "inst-0").transparency).toBe(0.7);
    expect(serialized(scene, "inst-1").transparency).toBeUndefined();
  });

  describe("sub-assemblies", () => {
    it("an occurrence's value reaches every instance inside it", () => {
      const { block, scene } = startAssembly();
      const sub = assembly("sub", () => ({ a: insert(block), b: insert(block) }));
      insert(sub).transparent(0.25);

      expect(serialized(scene, "asm-0/inst-0").transparency).toBe(0.25);
      expect(serialized(scene, "asm-0/inst-1").transparency).toBe(0.25);
    });

    it("opacities multiply through nested occurrences", () => {
      const { block, scene } = startAssembly();
      const inner = assembly("inner", () => ({ b: insert(block).transparent(0.5) }));
      const outer = assembly("outer", () => ({ i: insert(inner).transparent(0.5) }));
      insert(outer);

      // (1 - 0.5) × (1 - 0.5) = 0.25 opaque.
      expect(serialized(scene, "asm-0/asm-0/inst-0").transparency).toBeCloseTo(0.75, 12);
    });

    it("an opaque occurrence leaves its parts' own values untouched", () => {
      const { block, scene } = startAssembly();
      const sub = assembly("sub", () => ({ a: insert(block).transparent(0.3) }));
      insert(sub);

      expect(serialized(scene, "asm-0/inst-0").transparency).toBe(0.3);
    });
  });

  describe("replicas", () => {
    function seedWithMate(scene: AssemblyScene, block: Part) {
      const base = insert(block).grounded();
      const top = insert(block);
      const seed = insert(block);
      mate("fastened", seed.connectors.bottom, base.connectors.top);
      return { base, top, seed, scene };
    }

    it("a replica follows its seed's value, whatever the statement order", () => {
      const { block, scene } = startAssembly();
      const { base, top, seed } = seedWithMate(scene, block);
      const [copy] = replicate(seed, [base.connectors.top], [[top.connectors.top]]);
      seed.transparent(0.6);

      expect(serialized(scene, copy.record.instanceId).transparency).toBe(0.6);
    });

    it("a replica's own value overrides the seed's", () => {
      const { block, scene } = startAssembly();
      const { base, top, seed } = seedWithMate(scene, block);
      seed.transparent(0.6);
      const [copy] = replicate(seed, [base.connectors.top], [[top.connectors.top]]);
      copy.transparent(0.1);

      expect(serialized(scene, copy.record.instanceId).transparency).toBe(0.1);
      expect(serialized(scene, seed.record.instanceId).transparency).toBe(0.6);
    });
  });
});
