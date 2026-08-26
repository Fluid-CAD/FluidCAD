import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { SceneCompare } from "../rendering/scene-compare.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Scene } from "../rendering/scene.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import color from "../core/color.js";
import { } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";

const ACTOR_RECORD_KEYS: { key: string; actorField: string }[] = [
  { key: 'removedShapes', actorField: 'removedBy' },
  { key: 'addedFaces', actorField: 'addedBy' },
  { key: 'addedEdges', actorField: 'addedBy' },
  { key: 'modifiedFaces', actorField: 'modifiedBy' },
  { key: 'modifiedEdges', actorField: 'modifiedBy' },
  { key: 'removedFaces', actorField: 'removedBy' },
  { key: 'removedEdges', actorField: 'removedBy' },
];

function findByType(objects: SceneObject[], uniqueType: string): SceneObject {
  const found = objects.find(o => o.getUniqueType() === uniqueType);
  if (!found) {
    throw new Error(`No object with uniqueType ${uniqueType}`);
  }
  return found;
}

function findAllByType(objects: SceneObject[], uniqueType: string): SceneObject[] {
  return objects.filter(o => o.getUniqueType() === uniqueType);
}

function expectNoErrors(scene: Scene): void {
  const errored = scene.getAllSceneObjects().filter(o => o.getError());
  expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
}

function expectRawAlive(shape: Shape): void {
  expect(shape.isReleased()).toBe(false);
  expect(() => shape.getShape().ShapeType()).not.toThrow();
}

describe("SceneCompare resource disposal", () => {
  setupOC();

  function buildBox(height: number): void {
    sketch("xy", () => {
        testRect(100, 50);
      });
    extrude(height);
  }

  it("releases nothing when every object matches", () => {
    buildBox(30);
    render();

    const previousScene = getSceneManager().currentScene;
    const previousObjects = previousScene.getAllSceneObjects();
    const previousShapes = previousObjects.flatMap(o => o.getAddedShapes());

    const newScene = getSceneManager().startScene();
    buildBox(30);

    SceneCompare.compare(previousScene, newScene);

    for (const obj of previousObjects) {
      expect(obj.isDestroyed()).toBe(false);
    }
    for (const shape of previousShapes) {
      expectRawAlive(shape);
    }

    expectNoErrors(render());
  });

  it("destroys the invalidated suffix and releases its OC memory", () => {
    buildBox(30);
    render();

    const previousScene = getSceneManager().currentScene;
    const oldSketch = findByType(previousScene.getAllSceneObjects(), "sketch");
    const oldExtrude = findByType(previousScene.getAllSceneObjects(), "extrude-by-distance");
    const oldSolid = oldExtrude.getAddedShapes()[0];
    const oldRaw = oldSolid.getShape();

    const newScene = getSceneManager().startScene();
    buildBox(50);

    SceneCompare.compare(previousScene, newScene);

    expect(oldSketch.isDestroyed()).toBe(false);
    expect(oldExtrude.isDestroyed()).toBe(true);

    expect(oldSolid.isReleased()).toBe(true);
    expect(oldSolid.getMeshes()).toBe(null);
    expect(() => oldSolid.getShape()).toThrow(/released/);
    expect(() => (oldRaw as any).ShapeType()).toThrow();

    // The matched sketch subtree keeps its geometry — same instances now
    // serve the new scene.
    for (const child of oldSketch.getChildren()) {
      for (const shape of child.getAddedShapes()) {
        expectRawAlive(shape);
      }
    }

    expectNoErrors(render());
  });

  it("keeps shapes consumed by an invalidated feature alive for the rebuild", () => {
    buildBox(30);
    sketch("xy", () => {
        testRect(40, 40);
      });
    extrude(60);
    render();

    const previousScene = getSceneManager().currentScene;
    const [oldExtrude1, oldExtrude2] = findAllByType(previousScene.getAllSceneObjects(), "extrude-by-distance");
    // Premise: the second extrude fused with and consumed the first solid.
    expect(oldExtrude1.getRemovedShapes().length).toBeGreaterThan(0);
    const consumedSolid = oldExtrude1.getAddedShapes()[0];
    const oldFusedRaw = oldExtrude2.getAddedShapes()[0].getShape();

    const newScene = getSceneManager().startScene();
    buildBox(30);
    sketch("xy", () => {
        testRect(40, 40);
      });
    extrude(80);

    SceneCompare.compare(previousScene, newScene);

    expect(oldExtrude1.isDestroyed()).toBe(false);
    expect(oldExtrude2.isDestroyed()).toBe(true);
    expect(() => (oldFusedRaw as any).ShapeType()).toThrow();

    // The consumed base solid must survive: its removal record was pruned
    // with the dead consumer, and the rebuilt extrude re-consumes it.
    expectRawAlive(consumedSolid);
    const newExtrude1 = findAllByType(newScene.getAllSceneObjects(), "extrude-by-distance")[0];
    expect(newExtrude1.getRemovedShapes()).toEqual([]);

    const rendered = render();
    expectNoErrors(rendered);

    const newObjects = new Set(newScene.getAllSceneObjects());
    const rebuiltRemovals = newExtrude1.getRemovedShapes();
    expect(rebuiltRemovals.length).toBeGreaterThan(0);
    for (const record of rebuiltRemovals) {
      expect(newObjects.has(record.removedBy)).toBe(true);
    }
  });

  it("keeps raw handles shared through Solid.copy when only the copier dies", () => {
    sketch("xy", () => {
        testRect(200, 100);
      });
    const e1 = extrude(20).draft(15);
    color("red", e1.sideFaces(face().above("yz")));
    render();

    const previousScene = getSceneManager().currentScene;
    const oldExtrude = findByType(previousScene.getAllSceneObjects(), "extrude-by-distance");
    const oldSelect = findByType(previousScene.getAllSceneObjects(), "lazy-select");
    const oldColor = findByType(previousScene.getAllSceneObjects(), "color");

    const ownerSolid = oldExtrude.getAddedShapes()[0];
    const copiedSolid = oldColor.getAddedShapes()[0];
    const sharedRaw = copiedSolid.getShape();
    expect(sharedRaw).toBe(ownerSolid.getShape());

    const newScene = getSceneManager().startScene();
    sketch("xy", () => {
        testRect(200, 100);
      });
    const e2 = extrude(20).draft(15);
    color("blue", e2.sideFaces(face().above("xz")));

    SceneCompare.compare(previousScene, newScene);

    expect(oldExtrude.isDestroyed()).toBe(false);
    expect(oldSelect.isDestroyed()).toBe(true);
    expect(oldColor.isDestroyed()).toBe(true);

    // The copier's wrapper is gone, but the raw handle it shared with the
    // surviving owner solid must not be deleted.
    expect(copiedSolid.isReleased()).toBe(true);
    expect(() => copiedSolid.getShape()).toThrow(/released/);
    expect(() => (sharedRaw as any).ShapeType()).not.toThrow();
    expectRawAlive(ownerSolid);

    // The dead selection referenced faces owned by the surviving extrude's
    // classification state — those must stay alive too.
    for (const picked of oldSelect.getAddedShapes()) {
      expectRawAlive(picked);
    }

    expectNoErrors(render());
  });

  it("remaps surviving actor records onto the new instances", () => {
    buildBox(30);
    sketch("xy", () => {
        testRect(40, 40);
      });
    extrude(60);
    render();

    const previousScene = getSceneManager().currentScene;

    const newScene = getSceneManager().startScene();
    buildBox(30);
    sketch("xy", () => {
        testRect(40, 40);
      });
    extrude(60);

    SceneCompare.compare(previousScene, newScene);

    const newObjects = new Set(newScene.getAllSceneObjects());
    let recordCount = 0;
    for (const obj of newScene.getAllSceneObjects()) {
      for (const { key, actorField } of ACTOR_RECORD_KEYS) {
        const records = obj.getFullState().get(key) ?? [];
        for (const record of records) {
          recordCount++;
          expect(newObjects.has(record[actorField])).toBe(true);
        }
      }
    }
    expect(recordCount).toBeGreaterThan(0);

    expectNoErrors(render());
  });

  it("keeps releasing superseded generations across successive compares", () => {
    buildBox(30);
    render();
    const sceneV1 = getSceneManager().currentScene;

    const sceneV2 = getSceneManager().startScene();
    buildBox(50);
    SceneCompare.compare(sceneV1, sceneV2);
    render();
    const gen2Solid = findByType(sceneV2.getAllSceneObjects(), "extrude-by-distance").getAddedShapes()[0];

    const sceneV3 = getSceneManager().startScene();
    buildBox(70);
    SceneCompare.compare(sceneV2, sceneV3);

    expect(gen2Solid.isReleased()).toBe(true);
    const sketchV3 = findByType(sceneV3.getAllSceneObjects(), "sketch");
    for (const child of sketchV3.getChildren()) {
      for (const shape of child.getAddedShapes()) {
        expectRawAlive(shape);
      }
    }

    expectNoErrors(render());
  });

  it("fires onDestroy once per discarded object", () => {
    class HookedObject extends SceneObject {
      destroyCount = 0;

      constructor(private value: number) {
        super();
      }

      override getType(): string {
        return "hooked";
      }

      override serialize() {
        return {};
      }

      override build() {}

      override compareTo(other: SceneObject): boolean {
        if (!(other instanceof HookedObject)) {
          return false;
        }
        return super.compareTo(other) && this.value === other.value;
      }

      protected override onDestroy(): void {
        this.destroyCount++;
      }
    }

    const previousScene = getSceneManager().currentScene;
    const a1 = new HookedObject(1);
    const a2 = new HookedObject(2);
    addToScene(a1);
    addToScene(a2);

    const newScene = getSceneManager().startScene();
    addToScene(new HookedObject(1));
    addToScene(new HookedObject(99));

    SceneCompare.compare(previousScene, newScene);

    expect(a1.isDestroyed()).toBe(false);
    expect(a1.destroyCount).toBe(0);
    expect(a2.isDestroyed()).toBe(true);
    expect(a2.destroyCount).toBe(1);

    a2.destroy();
    expect(a2.destroyCount).toBe(1);
  });

  it("disposeScene tears down a whole scene", () => {
    buildBox(30);
    render();

    const scene = getSceneManager().currentScene;
    const objects = scene.getAllSceneObjects();
    const shapes = objects.flatMap(o => o.getAddedShapes());
    expect(shapes.length).toBeGreaterThan(0);

    getSceneManager().disposeScene(scene);

    for (const obj of objects) {
      expect(obj.isDestroyed()).toBe(true);
    }
    for (const shape of shapes) {
      expect(shape.isReleased()).toBe(true);
    }
  });
});
