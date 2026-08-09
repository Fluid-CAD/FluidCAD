import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { BoundConnector, Connector } from "../features/connector.js";
import { InstanceSelectSceneObject } from "../features/instance-select.js";
import { Part } from "../features/part.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";

function buildBlock(name = "block"): Part {
  return part(name, () => {
    sketch("xy", () => rect(20, 20));
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
  }) as unknown as Part;
}

function startAssembly(): AssemblyScene {
  return getSceneManager().startAssemblyScene();
}

describe("assembly-scoped instance connectors", () => {
  setupOC();

  it("instance.select() returns an instance-scoped selection registered in the scene", () => {
    const p = buildBlock();
    const scene = startAssembly();
    const a = insert(p);
    const sel = a.select(face().planar().onPlane("xy", 10));
    expect(sel).toBeInstanceOf(InstanceSelectSceneObject);
    expect((sel as InstanceSelectSceneObject).instanceId).toBe(a.record.instanceId);
    expect(scene.getAllSceneObjects()).toContain(sel);
  });

  it("instance.face()/edge() build a filter through the callback", () => {
    const p = buildBlock();
    startAssembly();
    const a = insert(p);
    const faceSel = a.face(f => f.planar().onPlane("xy", 10));
    const edgeSel = a.edge(e => e.line());
    expect(faceSel).toBeInstanceOf(InstanceSelectSceneObject);
    expect(edgeSel).toBeInstanceOf(InstanceSelectSceneObject);
  });

  it("connector() at assembly scope returns a mate-ready BoundConnector", () => {
    const p = buildBlock();
    const scene = startAssembly();
    const a = insert(p);
    const b = insert(p);
    const pivot = connector("pivot", a.select(face().planar().onPlane("xy", 10)));
    expect(pivot).toBeInstanceOf(BoundConnector);
    const bound = pivot as unknown as BoundConnector;
    expect(bound.instanceId).toBe(a.record.instanceId);
    expect(bound.connector.boundInstanceId).toBe(a.record.instanceId);
    // Top-level scene object, not parented under the part container.
    expect(bound.connector.getParent()).toBeFalsy();
    expect(scene.getInstanceConnectors(a.record.instanceId)).toContain(bound.connector);
    expect(scene.getInstanceConnectors(b.record.instanceId)).toHaveLength(0);
    // mate() accepts it directly.
    mate("revolute", pivot, b.connectors.top);
    expect(scene.getMates()).toHaveLength(1);
  });

  it("connector() at assembly scope supports the rotate/offset chain", () => {
    const p = buildBlock();
    startAssembly();
    const a = insert(p);
    const pivot = connector("pivot", a.select(face().planar().onPlane("xy", 10))) as unknown as BoundConnector;
    expect(pivot.rotate("x", 90).offset(0, 0, 5)).toBe(pivot);
  });

  it("accepts an anchored vertex over an instance selection (the on-the-fly form)", () => {
    // The mate dialog's on-the-fly create writes the anchor suffix:
    // `connector('c1', arm1.select(face()...).center())` — the source is an
    // AnchoredLazyVertex wrapping the instance selection, and the connector
    // must still bind to the instance behind it.
    startAssembly();
    const p = buildBlock();
    const a = insert(p);
    const c1 = connector("c1", a.select(face().planar().onPlane("xy", 10)).center()) as unknown as BoundConnector;
    expect(c1).toBeInstanceOf(BoundConnector);
    expect(c1.instanceId).toBe(a.record.instanceId);
    render();
    expect(c1.connector.getError()).toBeFalsy();
    const frame = c1.getFrame();
    // 20×20×10 block: top-face center at (10, 10, 10) in part-local space.
    expect(frame.origin.x).toBeCloseTo(10);
    expect(frame.origin.y).toBeCloseTo(10);
    expect(frame.origin.z).toBeCloseTo(10);
  });

  it("rejects a non-instance selection at assembly scope", () => {
    startAssembly();
    let sel: unknown;
    const p = part("leaky", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      sel = select(face().planar().onPlane("xy", 10));
    }) as unknown as Part;
    insert(p);
    expect(() => {
      connector("pivot", sel as Parameters<typeof connector>[1]);
    }).toThrow(/instance-scoped selection/i);
  });

  it("rejects a name colliding with the part's own connectors", () => {
    const p = buildBlock();
    startAssembly();
    const a = insert(p);
    expect(() => {
      connector("top", a.select(face().planar().onPlane("xy", 10)));
    }).toThrow(/already has a connector named "top"/i);
  });

  it("rejects a duplicate name on the same instance, allows it on another", () => {
    const p = buildBlock();
    startAssembly();
    const a = insert(p);
    const b = insert(p);
    connector("pivot", a.select(face().planar().onPlane("xy", 10)));
    expect(() => {
      connector("pivot", a.select(face().planar().onPlane("xy", 0)));
    }).toThrow(/already has a connector named "pivot"/i);
    expect(() => {
      connector("pivot", b.select(face().planar().onPlane("xy", 10)));
    }).not.toThrow();
  });

  it("builds the frame from the instance's part geometry and serializes instanceId", () => {
    // Assembly files declare their parts inside the assembly scene — build
    // the part after entering it so render() produces its geometry.
    startAssembly();
    const p = buildBlock();
    const a = insert(p).translate(100, 0, 0);
    const pivot = connector("pivot", a.select(face().planar().onPlane("xy", 10))) as unknown as BoundConnector;
    render();
    expect(pivot.connector.getError()).toBeFalsy();
    const frame = pivot.getFrame();
    // Part-local frame: the instance pose (translate 100) must NOT bake in —
    // the UI composes poses on the three.js group.
    expect(frame.origin.z).toBeCloseTo(10);
    expect(Math.abs(frame.origin.x)).toBeLessThan(11);
    const serialized = pivot.connector.serialize();
    expect(serialized.instanceId).toBe(a.record.instanceId);
    expect(serialized.name).toBe("pivot");
  });

  it("part-owned connectors serialize without an instanceId", () => {
    startAssembly();
    const p = buildBlock();
    insert(p);
    render();
    const top = p.getNamedConnectors()["top"];
    expect(top).toBeInstanceOf(Connector);
    expect(JSON.stringify(top.serialize())).not.toContain("instanceId");
  });
});
