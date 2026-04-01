import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";

export function fuseWithSceneObjects(sceneObjects: SceneObject[], extrusions: Shape<any>[]) {
  const modified: { shape: Shape<any>, object: SceneObject }[] = [];

  const objShapeMap = new Map<Shape<any>, SceneObject>();
  for (const obj of sceneObjects) {
    const shapes = obj.getShapes({}, 'solid');
    for (const shape of shapes) {
      objShapeMap.set(shape, obj);
    }
  }

  let args = Array.from(objShapeMap.keys());
  console.log("Fusing extrusions with scene objects. Extrusions:", extrusions.length, "Scene object shapes:", args.length);
  const all = [...args, ...extrusions];
  const { result, newShapes, modifiedShapes } = BooleanOps.fuse(all);

  if (newShapes.length === 0 && modifiedShapes.length === 0) {
    console.log("No fusions were made.");
    return {
      newShapes: extrusions,
      modifiedShapes: []
    }
  }

  for (const shape of modifiedShapes) {
    const obj = objShapeMap.get(shape);
    modified.push({ shape, object: obj });
  }

  return { newShapes: result, modifiedShapes: modified };
}
