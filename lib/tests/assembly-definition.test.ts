import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import assembly from "../core/assembly.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { Occurrence } from "../features/occurrence.js";
import { Instance } from "../features/instance.js";

function buildBlock(name = "block"): Part {
  return part(name, () => {
    sketch("xy", () => rect(20, 20));
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
  }) as unknown as Part;
}

function startAssembly(): { p: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const p = buildBlock();
  const scene = getSceneManager().startAssemblyScene();
  return { p, scene };
}

describe("assembly() definitions", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("is lazy — the callback does not run until insert()", () => {
    const { p } = startAssembly();
    let ran = 0;
    const def = assembly("sub", () => {
      ran++;
      insert(p);
    });
    expect(ran).toBe(0);
    insert(def);
    expect(ran).toBe(1);
    insert(def);
    expect(ran).toBe(2);
  });

  it("rejects a missing name or callback", () => {
    expect(() => assembly("" as any, () => {})).toThrow(/name/i);
    expect(() => assembly("sub", null as any)).toThrow(/callback/i);
  });

  it("insert(def) returns an Occurrence; insert(part) still returns an Instance", () => {
    const { p } = startAssembly();
    const def = assembly("sub", () => ({ b: insert(p) }));
    expect(insert(def)).toBeInstanceOf(Occurrence);
    expect(insert(p)).toBeInstanceOf(Instance);
  });

  it("insert() rejects values that are neither Part nor Assembly", () => {
    startAssembly();
    expect(() => insert({} as any)).toThrow(/Part or an assembly/i);
  });
});

describe("occurrence-scoped ids", () => {
  it("path-qualifies child ids and keeps per-scope counters independent", () => {
    const { p, scene } = startAssembly();
    const def = assembly("sub", () => ({ b: insert(p) }));

    const root0 = insert(p);         // root counter
    const occ0 = insert(def);        // first occurrence + its child
    const root1 = insert(p);         // root counter continues, unaffected by the child
    const occ1 = insert(def);        // second occurrence of the SAME definition

    expect(root0.record.instanceId).toBe("inst-0");
    expect(root1.record.instanceId).toBe("inst-1");
    expect(occ0.record.occurrenceId).toBe("asm-0");
    expect(occ1.record.occurrenceId).toBe("asm-1");
    expect(occ0.parts.b.record.instanceId).toBe("asm-0/inst-0");
    expect(occ1.parts.b.record.instanceId).toBe("asm-1/inst-0");
    expect(occ0.parts.b).not.toBe(occ1.parts.b);
    expect(scene.getInstances()).toHaveLength(4);
    expect(scene.getOccurrences()).toHaveLength(2);
  });

  it("nests occurrence paths recursively", () => {
    const { p } = startAssembly();
    const inner = assembly("inner", () => ({ leaf: insert(p) }));
    const outer = assembly("outer", () => ({
      sub: insert(inner),
      direct: insert(p),
    }));

    const occ = insert(outer);
    expect(occ.record.occurrenceId).toBe("asm-0");
    expect(occ.parts.sub.record.occurrenceId).toBe("asm-0/asm-0");
    expect(occ.parts.sub.parts.leaf.record.instanceId).toBe("asm-0/asm-0/inst-0");
    expect(occ.parts.direct.record.instanceId).toBe("asm-0/inst-0");
    expect(occ.parts.sub.record.parentPath).toBe("asm-0");
    expect(occ.parts.direct.record.owner).toBe("asm-0");
  });

  it("restores the parent scope when the body throws", () => {
    const { p, scene } = startAssembly();
    const bad = assembly("bad", () => {
      insert(p);
      throw new Error("boom");
    });
    expect(() => insert(bad)).toThrow("boom");
    expect(scene.currentScopePath()).toBe("");
    // Next root insert keeps counting in root scope.
    expect(insert(p).record.instanceId).toBe("inst-0");
  });
});

describe("scoped grounding", () => {
  it("a child's declared grounded() does NOT world-ground an ungrounded occurrence", () => {
    const { p, scene } = startAssembly();
    const def = assembly("sub", () => {
      insert(p).grounded();  // anchor of the sub-assembly's frame
      insert(p);
    });
    insert(def);
    const serialized = scene.getSerializedInstances();
    expect(serialized.map(s => s.grounded)).toEqual([false, false]);
  });

  it("grounding the occurrence grounds the child's declared anchors only", () => {
    const { p, scene } = startAssembly();
    const def = assembly("sub", () => {
      insert(p).grounded();
      insert(p);
    });
    insert(def).grounded();
    const serialized = scene.getSerializedInstances();
    expect(serialized.find(s => s.instanceId === "asm-0/inst-0")!.grounded).toBe(true);
    expect(serialized.find(s => s.instanceId === "asm-0/inst-1")!.grounded).toBe(false);
  });

  it("root-scope grounded() behavior is unchanged", () => {
    const { p, scene } = startAssembly();
    insert(p).grounded();
    insert(p);
    const serialized = scene.getSerializedInstances();
    expect(serialized[0].grounded).toBe(true);
    expect(serialized[1].grounded).toBe(false);
  });

  it("a grounded occurrence with no declared anchor pins its first instance (fallback)", () => {
    const { p, scene } = startAssembly();
    const def = assembly("sub", () => {
      insert(p);
      insert(p);
    });
    insert(def).grounded();
    const serialized = scene.getSerializedInstances();
    expect(serialized.find(s => s.instanceId === "asm-0/inst-0")!.grounded).toBe(true);
    expect(serialized.find(s => s.instanceId === "asm-0/inst-1")!.grounded).toBe(false);
  });

  it("nested grounding requires the whole chain: outer AND inner grounded", () => {
    const { p, scene } = startAssembly();
    const inner = assembly("inner", () => {
      insert(p).grounded();
    });
    const outerGrounding = (groundInner: boolean) => assembly("outer", () => {
      const occ = insert(inner);
      if (groundInner) {
        occ.grounded();
      }
    });

    // Outer inserted ungrounded — nothing pinned, even with inner grounded.
    insert(outerGrounding(true));
    expect(scene.getSerializedInstances().every(s => !s.grounded)).toBe(true);

    // Fully grounded chain — the deep anchor is pinned.
    const { p: p2, scene: scene2 } = startAssembly();
    const inner2 = assembly("inner", () => {
      insert(p2).grounded();
    });
    const outer2 = assembly("outer", () => {
      insert(inner2).grounded();
    });
    insert(outer2).grounded();
    expect(scene2.getSerializedInstances()[0].grounded).toBe(true);

    // Broken in the middle — inner occurrence ungrounded blocks the chain.
    const { p: p3, scene: scene3 } = startAssembly();
    const inner3 = assembly("inner", () => {
      insert(p3).grounded();
    });
    const outer3 = assembly("outer", () => {
      insert(inner3);  // not grounded
    });
    insert(outer3).grounded();
    // Fallback anchor: outer is ground-connected but owns no direct
    // instances, so nothing is pinned (documented v1 limitation).
    expect(scene3.getSerializedInstances().every(s => !s.grounded)).toBe(true);
  });
});

describe("occurrence pose composition", () => {
  it("composes the occurrence transform onto child warm poses at serialize time", () => {
    const { p, scene } = startAssembly();
    const def = assembly("sub", () => {
      insert(p).translate(10, 0, 0);
    });
    insert(def).translate(0, 5, 0).rotate("z", 90);

    const child = scene.getSerializedInstances()[0];
    // Occurrence frame: rotate(z,90) spins its translate(0,5,0) to (-5,0,0).
    // Child local (10,0,0) rotates to (0,10,0) → world (-5,10,0).
    expect(child.position.x).toBeCloseTo(-5, 10);
    expect(child.position.y).toBeCloseTo(10, 10);
    expect(child.position.z).toBeCloseTo(0, 10);
    expect(child.quaternion.z).toBeCloseTo(Math.SQRT1_2, 10);
    expect(child.quaternion.w).toBeCloseTo(Math.SQRT1_2, 10);

    // Records stay LOCAL — composition is serialize-only.
    expect(scene.getInstances()[0].position).toEqual({ x: 10, y: 0, z: 0 });
    const occ = scene.getSerializedOccurrences()[0];
    expect(occ.position.x).toBeCloseTo(-5, 10);
    expect(occ.position.y).toBeCloseTo(0, 10);
  });

  it("composes through nested occurrence frames", () => {
    const { p, scene } = startAssembly();
    const inner = assembly("inner", () => {
      insert(p).translate(1, 0, 0);
    });
    const outer = assembly("outer", () => {
      insert(inner).translate(10, 0, 0);
    });
    insert(outer).translate(100, 0, 0);
    expect(scene.getSerializedInstances()[0].position).toEqual({ x: 111, y: 0, z: 0 });
  });
});

describe("occurrence serialization", () => {
  it("serializes occurrence records with groundConnected", () => {
    const { p, scene } = startAssembly();
    const inner = assembly("inner", () => {
      insert(p);
    });
    const outer = assembly("outer", () => {
      insert(inner).grounded();
    });
    insert(outer).name("machine base");

    const occs = scene.getSerializedOccurrences();
    expect(occs).toHaveLength(2);
    const outerOcc = occs.find(o => o.occurrenceId === "asm-0")!;
    const innerOcc = occs.find(o => o.occurrenceId === "asm-0/asm-0")!;
    expect(outerOcc.assemblyName).toBe("outer");
    expect(outerOcc.name).toBe("machine base");
    expect(outerOcc.grounded).toBe(false);
    expect(outerOcc.groundConnected).toBe(false);
    expect(innerOcc.grounded).toBe(true);
    // Inner declared grounded, but outer isn't — chain broken at the top.
    expect(innerOcc.groundConnected).toBe(false);
    expect(innerOcc.parentPath).toBe("asm-0");
  });
});

describe("mates across scopes", () => {
  it("scopes mate ids and binds child connectors through occurrence paths", () => {
    const { p, scene } = startAssembly();
    const def = assembly("sub", () => {
      const a = insert(p);
      const b = insert(p);
      mate("fastened", a.connectors.top, b.connectors.top);
      return { a, b };
    });
    const occ1 = insert(def);
    const occ2 = insert(def);
    mate("fastened", occ1.parts.a.connectors.top, occ2.parts.a.connectors.top);

    const mates = scene.getSerializedMates();
    expect(mates.map(m => m.mateId)).toEqual(["asm-0/mate-0", "asm-1/mate-0", "mate-0"]);
    expect(mates[0].connectorA.instanceId).toBe("asm-0/inst-0");
    expect(mates[2].connectorA.instanceId).toBe("asm-0/inst-0");
    expect(mates[2].connectorB.instanceId).toBe("asm-1/inst-0");
    expect(mates[2].owner).toBe("");
    expect(mates[0].owner).toBe("asm-0");
  });
});

describe("connectors inside assembly bodies", () => {
  it("rejects connector() declared in an assembly body — connectors are part-owned", () => {
    const { p } = startAssembly();
    const def = assembly("sub", () => {
      const b = insert(p);
      connector("mount", b.connectors.top as unknown as Parameters<typeof connector>[1]);
      return { b };
    });
    expect(() => insert(def)).toThrow(/inside a part\(\) block/i);
  });
});
