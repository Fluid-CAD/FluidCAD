import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { BoundConnector } from "../features/connector.js";

function buildHousing(name = "housing"): Part {
  return part(name, () => {
    sketch("xy", () => rect(20, 20));
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
    connector("bottom", select(face().planar().onPlane("xy", 0)));
  }) as unknown as Part;
}

function startAssemblyWithPart(): { p: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const p = buildHousing();
  const scene = getSceneManager().startAssemblyScene();
  return { p, scene };
}

describe("assembly scene", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  it("multiple inserts of the same part share the same partId", () => {
    const { p, scene } = startAssemblyWithPart();
    insert(p);
    insert(p);
    const instances = scene.getInstances();
    expect(instances).toHaveLength(2);
    expect(instances[0].part.id).toBe(instances[1].part.id);
    expect(instances[0].instanceId).not.toBe(instances[1].instanceId);
  });

  it("every instance starts at world origin with identity quaternion", () => {
    const { p, scene } = startAssemblyWithPart();
    insert(p);
    insert(p);
    for (const inst of scene.getInstances()) {
      expect(inst.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(inst.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    }
  });

  it("re-parsing always restarts instances at the origin", () => {
    {
      const { p, scene } = startAssemblyWithPart();
      const inst = insert(p);
      // Simulate a session-only drag by mutating the runtime pose.
      inst.record.position = { x: 50, y: 0, z: 0 };
      expect(scene.getInstances()[0].position.x).toBe(50);
    }
    // A fresh parse: new assembly scene + fresh insert.
    const { p, scene } = startAssemblyWithPart();
    insert(p);
    expect(scene.getInstances()[0].position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("Instance has grounded(), name(), translate(), and rotate(), but no orient() yet", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p);
    expect(typeof inst.grounded).toBe("function");
    expect(typeof inst.name).toBe("function");
    expect(typeof inst.translate).toBe("function");
    expect(typeof inst.rotate).toBe("function");
    expect("orient" in inst).toBe(false);
  });

  it(".rotate('x', 90) sets quaternion to a 90deg rotation around X and leaves position at origin", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p).rotate("x", 90);
    const half = Math.SQRT1_2;
    expect(inst.record.quaternion.x).toBeCloseTo(half);
    expect(inst.record.quaternion.y).toBeCloseTo(0);
    expect(inst.record.quaternion.z).toBeCloseTo(0);
    expect(inst.record.quaternion.w).toBeCloseTo(half);
    expect(inst.record.position.x).toBeCloseTo(0);
    expect(inst.record.position.y).toBeCloseTo(0);
    expect(inst.record.position.z).toBeCloseTo(0);
  });

  it(".rotate takes degrees, not radians", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p).rotate("z", 180);
    expect(inst.record.quaternion.x).toBeCloseTo(0);
    expect(inst.record.quaternion.y).toBeCloseTo(0);
    expect(inst.record.quaternion.z).toBeCloseTo(1);
    expect(inst.record.quaternion.w).toBeCloseTo(0);
  });

  it(".rotate calls compose left-to-right: two 90deg around X equals 180deg around X", () => {
    const { p } = startAssemblyWithPart();
    const a = insert(p).rotate("x", 90).rotate("x", 90);
    const b = insert(p).rotate("x", 180);
    expect(a.record.quaternion.x).toBeCloseTo(b.record.quaternion.x);
    expect(a.record.quaternion.y).toBeCloseTo(b.record.quaternion.y);
    expect(a.record.quaternion.z).toBeCloseTo(b.record.quaternion.z);
    expect(a.record.quaternion.w).toBeCloseTo(b.record.quaternion.w);
  });

  it(".translate then .rotate around world Z moves the position around the Z axis line", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p).translate(5, 0, 0).rotate("z", 90);
    expect(inst.record.position.x).toBeCloseTo(0);
    expect(inst.record.position.y).toBeCloseTo(5);
    expect(inst.record.position.z).toBeCloseTo(0);
  });

  it(".rotate then .translate: rotate happens at origin, then .translate overwrites position", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p).rotate("z", 90).translate(5, 0, 0);
    expect(inst.record.position).toEqual({ x: 5, y: 0, z: 0 });
  });

  it(".rotate returns this for chaining", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p);
    expect(inst.rotate("x", 90)).toBe(inst);
    expect(inst.rotate("y", 45).grounded().name("foo")).toBe(inst);
    expect(inst.record.grounded).toBe(true);
    expect(inst.record.name).toBe("foo");
  });

  it("re-parsing always restarts instances at identity quaternion", () => {
    {
      const { p } = startAssemblyWithPart();
      const inst = insert(p).rotate("x", 90);
      expect(inst.record.quaternion.w).toBeCloseTo(Math.SQRT1_2);
    }
    const { p, scene } = startAssemblyWithPart();
    insert(p);
    expect(scene.getInstances()[0].quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it(".grounded().name('foo') and .name('foo').grounded() produce identical records", () => {
    {
      const { p } = startAssemblyWithPart();
      const a = insert(p).grounded().name("foo");
      expect(a.record.grounded).toBe(true);
      expect(a.record.name).toBe("foo");
    }
    {
      const { p } = startAssemblyWithPart();
      const b = insert(p).name("foo").grounded();
      expect(b.record.grounded).toBe(true);
      expect(b.record.name).toBe("foo");
    }
  });

  it("default name is the part's name; override replaces it", () => {
    const { p } = startAssemblyWithPart();
    const a = insert(p);
    expect(a.record.name).toBe("housing");
    const b = insert(p).name("housing-2");
    expect(b.record.name).toBe("housing-2");
    // Renaming one doesn't affect the other.
    expect(a.record.name).toBe("housing");
  });

  it("Instance.connectors is a record keyed by the registered connector names", () => {
    const { p } = startAssemblyWithPart();
    const inst = insert(p);
    expect(typeof inst.connectors).toBe("object");
    expect(Array.isArray(inst.connectors)).toBe(false);
    expect(Object.keys(inst.connectors).sort()).toEqual(["bottom", "top"]);
    expect(inst.connectors.top).toBeInstanceOf(BoundConnector);
    expect(inst.connectors.bottom).toBeInstanceOf(BoundConnector);
  });

  it("each named connector carries the instance's id; two instances produce distinct refs", () => {
    const { p } = startAssemblyWithPart();
    const a = insert(p);
    const b = insert(p);
    expect(a.connectors.top.instanceId).toBe(a.record.instanceId);
    expect(b.connectors.top.instanceId).toBe(b.record.instanceId);
    expect(a.connectors.top.instanceId).not.toBe(b.connectors.top.instanceId);
    // Same underlying connector, distinct bound refs.
    expect(a.connectors.top.connector).toBe(b.connectors.top.connector);
  });

  it("getCurrentScene() returns an AssemblyScene after startAssemblyScene", () => {
    startAssemblyWithPart();
    expect(getCurrentScene()).toBeInstanceOf(AssemblyScene);
  });

  it("every registered connector appears on the instance — even without a return", () => {
    getSceneManager().startScene();
    const p = part("no-return", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      // No return statement at all: the name argument is the registration.
      connector("mount", select(face().planar().onPlane("xy", 10)));
    }) as unknown as Part;
    getSceneManager().startAssemblyScene();
    const inst = insert(p);
    expect(p.getConnectors()).toHaveLength(1);
    expect(Object.keys(inst.connectors)).toEqual(["mount"]);
    expect(inst.connectors.mount).toBeInstanceOf(BoundConnector);
  });

  it("the connector statement's name argument is the instance key", () => {
    getSceneManager().startScene();
    const p = part("housing", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      connector("mountTop", select(face().planar().onPlane("xy", 10)));
    }) as unknown as Part;
    getSceneManager().startAssemblyScene();
    const inst = insert(p);
    expect(Object.keys(inst.connectors)).toEqual(["mountTop"]);
    expect(inst.connectors.mountTop).toBeInstanceOf(BoundConnector);
  });
});
