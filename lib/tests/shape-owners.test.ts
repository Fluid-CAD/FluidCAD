// Which feature made a face or an edge of a rendered solid: the owners a
// dialog's feature picker takes a click on geometry as — a hole's wall and
// rim are the hole's, a plate's top the extrude's.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import hole from "../core/hole.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import select from "../core/select.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { Scene } from "../rendering/scene.js";
import { Shape } from "../common/shape.js";
import { edgeRefsWhere, faceRefsWhere } from "./selection/pick-helpers.js";

/** The one solid the scene ends with: the plate as the hole left it. */
function solidOf(scene: Scene): Shape {
  const solids = scene.getSceneObjects().filter(o => !o.isContainer()).flatMap(o => o.getShapes()).filter(s => s.isSolid());
  expect(solids).toHaveLength(1);
  return solids[0];
}

describe("the features that made a face or an edge", () => {
  setupOC();

  it("names the hole for its wall and its rim, nothing for a face it didn't make or a shape it doesn't know", () => {
    part("plate", () => {
      sketch("xy", () => {
        testRect(60, 40, { at: [-30, -20] });
      });
      extrude(10);
      const top = connector("top", select(face().planar().onPlane("xy", 10)));
      hole("M6", top);
    });
    const scene = render();
    const solid = solidOf(scene);
    const manager = getSceneManager();
    const at = (r: number) => (mid: { x: number; y: number }) => Math.abs(Math.hypot(mid.x, mid.y) - r) < 1e-3;

    // The hole's wall: a cylinder whose every edge midpoint lies 3.3 from the axis.
    const [wall] = faceRefsWhere(solid, at(3.3));
    expect(wall).toBeDefined();
    const wallOwners = manager.getShapeOwners(scene, solid.id, { type: 'face', index: wall.sub.index });
    expect(wallOwners.map(o => o.type)).toEqual(['hole']);
    expect(wallOwners[0]).toMatchObject({ uniqueType: 'hole', name: 'hole' });

    // Its rims are the hole's; the plate's top face is never the hole's (the
    // cut remade it, so the extrude's bucket holds its earlier self: no owner).
    const rims = edgeRefsWhere(solid, at(3.3));
    expect(rims.length).toBeGreaterThan(0);
    for (const rim of rims) {
      expect(manager.getShapeOwners(scene, solid.id, { type: 'edge', index: rim.sub.index }).map(o => o.type)).toContain('hole');
    }
    const [top] = faceRefsWhere(solid, mid => Math.abs(mid.z - 10) < 1e-6);
    expect(top).toBeDefined();
    expect(manager.getShapeOwners(scene, solid.id, { type: 'face', index: top.sub.index }).map(o => o.type)).not.toContain('hole');

    expect(manager.getShapeOwners(scene, 'no-such-shape', { type: 'face', index: 0 })).toEqual([]);
    expect(manager.getShapeOwners(scene, solid.id, { type: 'face', index: 999 })).toEqual([]);
  });
});
