import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import select from "../../core/select.js";
import { edge, face } from "../../filters/index.js";
import { EdgeFilterBuilder } from "../../filters/edge/edge-filter.js";
import { FaceFilterBuilder } from "../../filters/face/face-filter.js";
import { SelectSceneObject } from "../../features/select.js";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Matrix4 } from "../../math/matrix4.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Scene } from "../../rendering/scene.js";
import { testRect } from "../helpers/profiles.js";

/** A 20 × 20 × 10 block at the origin and a selection of its top face, repeated twice along x by 40. */
function repeatedTopFace(): { seed: SelectSceneObject; scene: Scene } {
  sketch("xy", () => {
    testRect(20, 20);
  });
  const e = extrude(10).new() as unknown as SceneObject;
  const seed = select(face().planar().onPlane("xy", 10)) as unknown as SelectSceneObject;
  repeat("linear", "x", { count: 2, offset: 40 }, e, seed as unknown as SceneObject);
  return { seed, scene: render() };
}

function cloneOf(scene: Scene, source: SceneObject): SelectSceneObject {
  const clone = scene.getAllSceneObjects().find(o => o.getCloneSource() === source);
  expect(clone).toBeInstanceOf(SelectSceneObject);
  return clone as SelectSceneObject;
}

describe("select() under a repeat", () => {
  setupOC();

  it("a repeated face selection still selects faces — the clone's own top face", () => {
    const { seed, scene } = repeatedTopFace();
    const clone = cloneOf(scene, seed);

    expect(clone.shapeType()).toBe("face");
    const shapes = clone.getShapes();
    expect(shapes.length).toBe(1);
    expect(shapes[0]).toBeInstanceOf(Face);
    const box = ShapeOps.getBoundingBox(shapes[0]);
    expect(box.centerX).toBeCloseTo(50, 6);
    expect(box.centerZ).toBeCloseTo(10, 6);
  });

  it("transform() and remap() keep the builder's class", () => {
    const faces = face().planar();
    const edges = edge().line();
    const move = Matrix4.fromTranslation(40, 0, 0);

    expect(faces.transform(move)).toBeInstanceOf(FaceFilterBuilder);
    expect(faces.remap(new Map())).toBeInstanceOf(FaceFilterBuilder);
    expect(edges.transform(move)).toBeInstanceOf(EdgeFilterBuilder);
    expect(edges.remap(new Map())).toBeInstanceOf(EdgeFilterBuilder);
  });

  it("a repeated edge selection stays an edge selection", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const e = extrude(10).new() as unknown as SceneObject;
    const seed = select(edge().line().onPlane("xy", 10)) as unknown as SelectSceneObject;
    repeat("linear", "x", { count: 2, offset: 40 }, e, seed as unknown as SceneObject);
    const clone = cloneOf(render(), seed);

    expect(clone.shapeType()).toBe("edge");
    const shapes = clone.getShapes();
    expect(shapes.length).toBe(4);
    expect(shapes.every(s => s instanceof Edge)).toBe(true);
    const centers = shapes.map(s => ShapeOps.getBoundingBox(s).centerX).sort((a, b) => a - b);
    expect(centers).toEqual([40, 50, 50, 60].map(x => expect.closeTo(x, 6)));
  });
});
