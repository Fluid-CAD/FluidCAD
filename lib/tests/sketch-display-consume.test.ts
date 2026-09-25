import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import remove from "../core/remove.js";
import { circle, region } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";
import { Sketch } from "../features/2d/sketch.js";
import { Extrude } from "../features/extrude.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "../rendering/scene.js";
import { SceneRenderer } from "../rendering/render.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";

// A 3D feature consumes its sketch for display only. The wires leave the
// rendered scene from the consumer on (and return when the timeline is
// scrubbed before it), but scope-less readers keep seeing them, so a later
// feature can take the same sketch again. `remove()` is the one hard
// removal left.
describe("sketch display consumption", () => {
  setupOC();

  function fullScope(scene: Scene): Set<SceneObject> {
    return new Set(scene.getAllSceneObjects());
  }

  function drawnChildren(s: Sketch): SceneObject[] {
    return s.getChildren().filter(child => child.getOwnShapes({ excludeMeta: false, excludeGuide: false }).length > 0);
  }

  it("hides the consumed sketch from the render and shows it again before the consumer", () => {
    const s = sketch("xy", () => { testRect(40, 20); }) as unknown as Sketch;
    const e = extrude(10) as Extrude;
    const scene = render();

    expect(s.getShapes().length).toBeGreaterThan(0);
    expect(s.getShapes(undefined, undefined, fullScope(scene))).toHaveLength(0);
    const row = scene.getRenderedObject(s)!;
    expect(row.visible).toBe(false);
    expect(row.sceneShapes).toHaveLength(0);

    const beforeExtrude = fullScope(scene);
    beforeExtrude.delete(e);
    expect(s.getShapes(undefined, undefined, beforeExtrude).length).toBeGreaterThan(0);
  });

  it("carries the hidden wires on the entity rows and the consumer on the sketch row", () => {
    const s = sketch("xy", () => { testRect(40, 20); }) as unknown as Sketch;
    const e = extrude(10) as Extrude;
    const scene = render();

    const sketchRow = scene.getRenderedObject(s)!;
    expect(sketchRow.consumedBy).toBe(e.id);
    expect(sketchRow.hiddenShapes).toBeUndefined();
    // Only the entities that draw — a constraint statement owns no shapes.
    const entityRows = drawnChildren(s).map(child => scene.getRenderedObject(child)!);
    expect(entityRows.length).toBeGreaterThan(0);
    for (const row of entityRows) {
      expect(row.sceneShapes).toHaveLength(0);
      expect(row.hiddenShapes!.length).toBeGreaterThan(0);
      expect(row.hiddenShapes!.every(shape => shape.meshes.length > 0)).toBe(true);
    }
    // The solid's own row carries nothing hidden.
    expect(scene.getRenderedObject(e)!.hiddenShapes).toBeUndefined();
  });

  it("carries no hidden wires and no consumer before the consumer in a rollback", () => {
    const s = sketch("xy", () => { testRect(40, 20); }) as unknown as Sketch;
    const e = extrude(10) as Extrude;
    const scene = render();
    const stop = scene.getAllSceneObjects().indexOf(e) - 1;
    const rolled = new SceneRenderer(DEFAULT_MESH_CONFIG).renderRollback(scene, stop);

    const sketchRow = rolled.getRenderedObject(s)!;
    expect(sketchRow.visible).toBe(true);
    expect(sketchRow.consumedBy).toBeUndefined();
    for (const child of drawnChildren(s)) {
      const row = rolled.getRenderedObject(child)!;
      expect(row.hiddenShapes).toBeUndefined();
      expect(row.sceneShapes.length).toBeGreaterThan(0);
    }
  });

  it("lets a later feature take a consumed sketch again", () => {
    const s = sketch("xy", () => { testRect(40, 20); }) as unknown as Sketch;
    const first = extrude(10, s) as Extrude;
    const second = extrude(-10, s) as Extrude;
    render();

    expect(first.getError()).toBeNull();
    expect(second.getError()).toBeNull();
    // The second extrude fused with the first: one solid spans both.
    const solids = second.getShapes();
    expect(solids).toHaveLength(1);
    expect(solids[0].getType()).toBe("solid");
    expect(s.getShapes(undefined, undefined, new Set([s, first, second]))).toHaveLength(0);
  });

  it("extrudes two regions of one sketch to their own heights", () => {
    const s = sketch("xy", () => {
      const outer = circle([0, 0], 60);
      const inner = circle([0, 0], 30);
      region("ring", outer);
      region("disc", inner);
    }) as unknown as Sketch;
    const ring = extrude(10, s).region("ring") as Extrude;
    const disc = extrude(25, s).region("disc") as Extrude;
    render();

    expect(ring.getError()).toBeNull();
    expect(disc.getError()).toBeNull();
    expect(disc.getShapes()).toHaveLength(1);
  });

  it("remove() still drops the sketch for readers", () => {
    const s = sketch("xy", () => { testRect(40, 20); }) as unknown as Sketch;
    extrude(10, s);
    remove(s);
    const scene = render();

    expect(s.getShapes()).toHaveLength(0);
    expect(s.getShapes(undefined, undefined, fullScope(scene))).toHaveLength(0);
  });
});
