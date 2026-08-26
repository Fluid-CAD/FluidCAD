import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import part from "../core/part.js";
import select from "../core/select.js";
import expose from "../core/expose.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Exposed } from "../features/exposed.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "../rendering/scene.js";

// expose() is a publication, not a consumer — but a published select()'s
// highlight must not stay rendered forever. The render-only (soft) removal
// hides it from scoped (renderer) reads while scope-less feature reads —
// classification, sourceServes matching, cross-part consumers — keep
// seeing the shapes.
describe("expose() display consumption", () => {
  setupOC();

  function findExposed(scene: Scene): Exposed {
    const exposed = scene.getAllSceneObjects().find((o): o is Exposed => o instanceof Exposed);
    expect(exposed).toBeDefined();
    return exposed!;
  }

  function fullScope(scene: Scene): Set<SceneObject> {
    return new Set(scene.getAllSceneObjects());
  }

  it("hides a published select's highlight from the rendered scene, keeps it for readers", () => {
    part("donor", () => {
      sketch("xy", () => { testRect(40, 20); });
      extrude(10);
      expose("top", select(face().planar().onPlane("xy", 10)));
    });
    const scene = render();
    const exposed = findExposed(scene);
    const source = exposed.source;

    // Scope-less read (feature builds, pick matching, classification):
    // the shapes are still served.
    expect(source.getShapes().length).toBeGreaterThan(0);

    // Scoped read (the renderer's rollback-aware pass over the full
    // timeline): the highlight is hidden once the expose() has run.
    expect(source.getShapes(undefined, undefined, fullScope(scene))).toHaveLength(0);

    // And the MAIN render pass emitted no shapes for the select either —
    // this is what actually keeps the highlight off the screen (the full
    // render collects shapes through its own scope, not scope-less).
    const rendered = scene.getRenderedObjects().find(r => r.id === source.id);
    expect(rendered).toBeDefined();
    expect(rendered!.sceneShapes).toHaveLength(0);

    // Scrubbed BEFORE the expose statement, the selection shows again —
    // the same timeline behavior a hard-consumed selection has.
    const beforeExpose = fullScope(scene);
    beforeExpose.delete(exposed);
    expect(source.getShapes(undefined, undefined, beforeExpose).length).toBeGreaterThan(0);

    // And the exposure still classifies its contact geometry.
    const serialized = exposed.serialize();
    expect(serialized.seed?.form).toBe("plane");
  });

  it("keeps reusable sketch sources fully visible (they are shared geometry)", () => {
    part("donor", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      extrude(10, s);
      expose("profile", s);
    });
    const scene = render();
    const exposed = findExposed(scene);

    // The reusable guard skips the display removal, mirroring removeShapes.
    const shapes = exposed.source.getShapes(
      { excludeGuide: false }, undefined, fullScope(scene),
    );
    expect(shapes.length).toBeGreaterThan(0);
  });
});
