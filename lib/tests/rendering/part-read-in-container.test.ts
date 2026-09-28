import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import type { PartDefinition } from "../../features/part-definition.js";
import part from "../../core/part.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import expose from "../../core/expose.js";
import project from "../../core/2d/project.js";
import { circle, line } from "../../core/2d/index.js";
import type { IExtrude } from "../../core/interfaces.js";

// part() is lazy: a definition first read inside another container's body
// (a top-level sketch projecting `def.features.face`) builds right there.
// Its template lands before that container — the container reads it, and a
// solved sketch registers its projections before its solve — so the
// container's objects stay one run for the compare's all-or-nothing cache.

function exposingPart(name: string): PartDefinition<unknown> {
  return part(name, () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(10) as unknown as IExtrude;
    expose("side", e.sideFaces() as any);
  });
}

/** A top-level sketch on a standard plane whose body projects a part's exposure. */
function projectingSketch(withLine: boolean) {
  const def = exposingPart("Base");
  let projection: SceneObject | null = null;
  let drawn: SceneObject | null = null;
  const onPlane = sketch("xy", () => {
    projection = project(def.features.side as any) as unknown as SceneObject;
    if (withLine) {
      drawn = line([-5, 3], [-1, -2]) as unknown as SceneObject;
    }
  }) as unknown as SceneObject;
  return { def, onPlane, projection: projection!, drawn };
}

function isRunOf(container: SceneObject, scene: Scene): boolean {
  const built = scene.getAllSceneObjects();
  const start = built.indexOf(container);
  const members = built.filter(o => o === container || isWithin(o, container));
  return built.slice(start, start + members.length).every(o => members.includes(o));
}

function isWithin(obj: SceneObject, container: SceneObject): boolean {
  for (let parent = obj.getParent(); parent; parent = parent.getParent()) {
    if (parent === container) {
      return true;
    }
  }
  return false;
}

describe("part read inside a container body", () => {
  setupOC();

  it("builds the part before a top-level sketch that projects it, so the projection registers", () => {
    const { def, onPlane, projection } = projectingSketch(false);
    const scene = render();
    const built = scene.getAllSceneObjects();

    expect(built.indexOf(def.builtVariantsIn(scene)[0])).toBeLessThan(built.indexOf(onPlane));
    expect(isRunOf(onPlane, scene)).toBe(true);
    // Fixed solver entities in the sketch's own snapshot: what the UI's
    // constrained (green) tint keys on.
    const entities = scene.getRenderedObject(projection)!.object.entities as { entityId: number }[];
    expect(entities.length).toBeGreaterThan(0);
    const solved = new Set(
      (scene.getRenderedObject(onPlane)!.object.solver.entities as { id: number }[]).map(e => e.id),
    );
    expect(entities.every(e => solved.has(e.entityId))).toBe(true);
  });

  it("re-renders that sketch whole when a line joins it, never half from the cache", () => {
    projectingSketch(false);
    const first = render();
    const manager = getSceneManager();
    const second = manager.startScene();
    const { onPlane, drawn } = projectingSketch(true);
    second.materializeLeftoverDefinitions();
    const scene = manager.compare(first, second);
    manager.renderScene(scene);

    expect(scene.isCached(onPlane)).toBe(false);
    expect(drawn!.getError()).toBeFalsy();
    expect(scene.getRenderedObject(drawn!)?.visible).toBe(true);
  });

  it("builds a part another part body reads before that part, keeping its members one run", () => {
    let donor: PartDefinition<unknown> | null = null;
    const consumer = part("Consumer", () => {
      sketch("xz", () => {
        project(donor!.features.side as any);
      });
    });
    donor = exposingPart("Donor");
    const scene = render();
    const built = scene.getAllSceneObjects();
    const consumerPart = consumer.builtVariantsIn(scene)[0];

    expect(built.indexOf(donor.builtVariantsIn(scene)[0])).toBeLessThan(built.indexOf(consumerPart));
    expect(isRunOf(consumerPart, scene)).toBe(true);
  });
});
