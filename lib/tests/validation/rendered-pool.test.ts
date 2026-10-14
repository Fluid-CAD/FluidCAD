import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { RenderedSolidPool } from "../../validation/rendered-pool.js";
import { SceneValidator } from "../../validation/scene-validator.js";
import { SceneInterference } from "../../validation/scene-interference.js";

function assertClean(scene: Scene): void {
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
}

/** Every shape id a rendered object of the scene carries, with its kernel type. */
function renderedShapeTypes(scene: Scene): Map<string, string> {
  const types = new Map<string, string>();
  for (const rendered of scene.getRenderedObjects()) {
    for (const shape of rendered.sceneShapes) {
      types.set(shape.shapeId, shape.shapeType);
    }
  }
  return types;
}

describe("RenderedSolidPool.solidIdsByInstance", () => {
  setupOC();

  it("lists each instance's rendered solids — shared per part — exactly as validate and interfere address them", () => {
    const scene = getSceneManager().startAssemblyScene();
    // Two separate solids in one part, and its sketches, which are not solids.
    const frame = part("frame", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
      sketch("xy", () => {
        testRect(20, 20, { at: [40, 0] });
      });
      extrude(10).new();
    });
    const box = part("box", () => {
      sketch("xy", () => {
        testRect(10, 10);
      });
      extrude(5);
    });
    // Declared, never inserted: nothing of it is in the pool.
    part("spare", () => {
      sketch("xy", () => {
        testRect(5, 5);
      });
      extrude(5);
    });
    insert(frame).name("frame a");
    insert(frame).translate(0, 50, 0).name("frame b");
    insert(box).translate(0, 0, 30).name("box");
    render();
    assertClean(scene);

    const byName = new Map(scene.getSerializedInstances().map(i => [i.name, i.instanceId]));
    const ids = RenderedSolidPool.solidIdsByInstance(scene);
    expect(ids).not.toBeNull();
    expect([...ids!.keys()].sort()).toEqual([...byName.values()].sort());

    const frameA = ids!.get(byName.get("frame a")!)!;
    const frameB = ids!.get(byName.get("frame b")!)!;
    const boxIds = ids!.get(byName.get("box")!)!;
    expect(frameA).toHaveLength(2);
    expect(frameB).toEqual(frameA);
    expect(boxIds).toHaveLength(1);
    expect(boxIds).not.toContain(frameA[0]);

    const types = renderedShapeTypes(scene);
    for (const id of [...frameA, ...boxIds]) {
      expect(types.get(id)).toBe("solid");
    }

    // validate { instanceId } checks exactly these shapes.
    for (const instanceId of byName.values()) {
      const outcome = SceneValidator.validate(scene, { instanceId });
      expect(outcome.kind).toBe("report");
      if (outcome.kind === "report") {
        expect(outcome.report.shapes.map(s => s.shapeId)).toEqual(ids!.get(instanceId));
      }
    }

    // interfere places one body per listed id per instance.
    const checked = SceneInterference.check(scene);
    expect(checked.kind).toBe("report");
    if (checked.kind === "report") {
      expect(checked.report.bodies).toBe(frameA.length + frameB.length + boxIds.length);
    }
  });

  it("is null for a part scene", () => {
    part("box", () => {
      sketch("xy", () => {
        testRect(10, 10);
      });
      extrude(5);
    });
    const scene = render();
    assertClean(scene);
    expect(RenderedSolidPool.solidIdsByInstance(scene)).toBeNull();
    expect(getSceneManager().getInstanceShapeIds(scene)).toBeNull();
  });
});
