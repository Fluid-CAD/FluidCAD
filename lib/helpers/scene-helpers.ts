import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";

export function fuseWithSceneObjects(sceneObjects: SceneObject[], extrusions: Shape<any>[]) {
  const modified: { shape: Shape<any>, object: SceneObject }[] = [];

  const objShapeMap = new Map<Shape<any>, SceneObject>();
  for (const obj of sceneObjects) {
    const shapes = obj.getShapes(false, 'solid');
    for (const shape of shapes) {
      objShapeMap.set(shape, obj);
    }
  }

  const { newShapes, modifiedShapes } = BooleanOps.fuseMultiShapeWithCleanup(Array.from(objShapeMap.keys()), extrusions);

  if (newShapes.length === 0 && modifiedShapes.length === 0) {
    console.log("No fusions were made.");
    return {
      extrusions,
      modifiedShapes: []
    }
  }

  console.log("Final fused solids count:", newShapes.length);
  console.log("Modified shapes count:", modifiedShapes.length);

  extrusions = newShapes;

  for (const shape of modifiedShapes) {
    const obj = objShapeMap.get(shape);
    modified.push({ shape, object: obj });
  }

  return { extrusions, newShapes, modifiedShapes: modified };
}
