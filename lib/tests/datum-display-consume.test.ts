import { describe, it, expect } from "vitest";
import { setupOC, render, expectDisplayConsumed } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import plane from "../core/plane.js";
import axis from "../core/axis.js";
import mirror from "../core/mirror.js";
import revolve from "../core/revolve.js";
import remove from "../core/remove.js";
import { circle } from "../core/2d/index.js";
import { fix, diameter } from "../core/constraints/index.js";
import { testRect } from "./helpers/profiles.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";
import { Extrude } from "../features/extrude.js";
import { Revolve } from "../features/revolve.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "../rendering/scene.js";
import { SceneRenderer } from "../rendering/render.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";

// Planes and axes follow the sketch rule: a feature consumes them for display
// only. The quad or the dashed line leaves the rendered scene from the
// consumer on (and returns when the timeline is scrubbed before it), but
// scope-less readers keep seeing it, so a later feature can take the same
// datum again. `remove()` is the one hard removal left.
describe("plane and axis display consumption", () => {
  setupOC();

  const ALL = { excludeMeta: false, excludeGuide: false };

  function fullScope(scene: Scene): Set<SceneObject> {
    return new Set(scene.getAllSceneObjects());
  }

  function profileOffAxis() {
    const c = circle([40, 0], 10);
    fix(c.center(), [40, 0]);
    diameter(c, 20);
  }

  describe("plane", () => {
    it("hides a plane its sketch consumed and shows it again before the sketch", () => {
      const p = plane("xy", 20) as PlaneObjectBase;
      const s = sketch(p, () => { testRect(40, 20); }) as unknown as Sketch;
      const scene = render();

      expectDisplayConsumed(scene, p);
      const row = scene.getRenderedObject(p)!;
      expect(row.visible).toBe(false);
      expect(row.sceneShapes).toHaveLength(0);
      expect(row.consumedBy).toBe(s.id);
      expect(row.hiddenShapes).toHaveLength(1);
      expect(row.hiddenShapes![0].meshes.length).toBeGreaterThan(0);

      const beforeSketch = fullScope(scene);
      beforeSketch.delete(s);
      expect(p.getShapes(ALL, undefined, beforeSketch)).toHaveLength(1);
    });

    it("carries no hidden quad and no consumer before the sketch in a rollback", () => {
      const p = plane("xy", 20) as PlaneObjectBase;
      const s = sketch(p, () => { testRect(40, 20); }) as unknown as Sketch;
      const scene = render();
      const stop = scene.getAllSceneObjects().indexOf(s) - 1;
      const rolled = new SceneRenderer(DEFAULT_MESH_CONFIG).renderRollback(scene, stop);

      const row = rolled.getRenderedObject(p)!;
      expect(row.visible).toBe(true);
      expect(row.consumedBy).toBeUndefined();
      expect(row.hiddenShapes).toBeUndefined();
      expect(row.sceneShapes).toHaveLength(1);
    });

    it("lets two sketches share one plane", () => {
      const p = plane("xy", 20) as PlaneObjectBase;
      const s1 = sketch(p, () => { testRect(40, 20); }) as unknown as Sketch;
      const e1 = extrude(10, s1) as Extrude;
      const s2 = sketch(p, () => {
        const c = circle([60, 0], 5);
        fix(c.center(), [60, 0]);
        diameter(c, 10);
      }) as unknown as Sketch;
      const e2 = extrude(10, s2) as Extrude;
      const scene = render();

      expect(s2.getError()).toBeNull();
      expect(e1.getError()).toBeNull();
      expect(e2.getError()).toBeNull();
      // The second sketch sits on the same plane: its solid starts at z = 20.
      expect(s2.getPlane().origin.z).toBeCloseTo(20);
      // The first taker is the consumer on the plane's row.
      expect(scene.getRenderedObject(p)!.consumedBy).toBe(s1.id);
    });

    it("lets a mirror take a plane a sketch already used", () => {
      const p = plane("yz", 30) as PlaneObjectBase;
      sketch("xy", () => { testRect(20, 20); });
      const e = extrude(10) as Extrude;
      sketch(p, () => { testRect(10, 10); });
      extrude(5);
      const m = mirror(p, e) as unknown as SceneObject;
      render();

      expect(m.getError()).toBeNull();
      expect(m.getShapes().length).toBeGreaterThan(0);
    });

    it("remove() still drops a plane for readers", () => {
      const p = plane("xy", 20) as PlaneObjectBase;
      sketch(p, () => { testRect(40, 20); });
      remove(p);
      const scene = render();

      expect(p.getShapes(ALL)).toHaveLength(0);
      expect(p.getShapes(ALL, undefined, fullScope(scene))).toHaveLength(0);
    });
  });

  describe("axis", () => {
    it("hides an axis its revolve consumed and shows it again before the revolve", () => {
      const a = axis("z", { offsetX: 50 }) as AxisObjectBase;
      sketch("xz", profileOffAxis);
      const r = revolve(a) as Revolve;
      const scene = render();

      expect(r.getError()).toBeNull();
      expectDisplayConsumed(scene, a);
      const row = scene.getRenderedObject(a)!;
      expect(row.visible).toBe(false);
      expect(row.sceneShapes).toHaveLength(0);
      expect(row.consumedBy).toBe(r.id);
      expect(row.hiddenShapes).toHaveLength(1);
      expect(row.hiddenShapes![0].meshes.length).toBeGreaterThan(0);

      const beforeRevolve = fullScope(scene);
      beforeRevolve.delete(r);
      expect(a.getShapes(ALL, undefined, beforeRevolve)).toHaveLength(1);
    });

    it("lets two revolves share one axis", () => {
      const a = axis("z") as AxisObjectBase;
      sketch("xz", profileOffAxis);
      const r1 = revolve(a, 180) as Revolve;
      sketch("xz", () => {
        const c = circle([40, 30], 5);
        fix(c.center(), [40, 30]);
        diameter(c, 10);
      });
      const r2 = revolve(a, 180) as Revolve;
      render();

      expect(r1.getError()).toBeNull();
      expect(r2.getError()).toBeNull();
      expect(r2.getShapes().length).toBeGreaterThan(0);
    });

    it("remove() still drops an axis for readers", () => {
      const a = axis("z") as AxisObjectBase;
      sketch("xz", profileOffAxis);
      revolve(a);
      remove(a);
      const scene = render();

      expect(a.getShapes(ALL)).toHaveLength(0);
      expect(a.getShapes(ALL, undefined, fullScope(scene))).toHaveLength(0);
    });
  });

  it("emits no hidden shapes for a consumed selection", () => {
    // A selection is consumed for good: nothing to draw again.
    sketch("xy", () => { testRect(40, 20); });
    const e = extrude(10) as Extrude;
    const p = plane(e.endFaces(0), 5) as PlaneObjectBase;
    const scene = render();

    expect(p.getError()).toBeNull();
    const selectionRows = scene.getAllSceneObjects()
      .filter(o => o.getType() === "select")
      .map(o => scene.getRenderedObject(o)!);
    expect(selectionRows.length).toBeGreaterThan(0);
    for (const row of selectionRows) {
      expect(row.hiddenShapes).toBeUndefined();
      expect(row.consumedBy).toBeUndefined();
    }
  });
});
