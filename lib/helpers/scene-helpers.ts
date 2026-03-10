import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";

export function fuseWithSceneObjects(sceneObjects: SceneObject[], extrusions: Shape<any>[]) {
  const modified: { shape: Shape<any>, object: SceneObject }[] = [];

  const objShapeMap = new Map<Shape<any>, SceneObject>();
  for (const obj of sceneObjects) {
    const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
    for (const shape of shapes) {
      objShapeMap.set(shape, obj);
    }
  }

  let args = Array.from(objShapeMap.keys());
  let newShapes: Shape<any>[] = [];
  let modifiedShapes: Shape<any>[] = [];
  if (args.length === 0 && extrusions.length > 1) {
    let fused = extrusions[0];
    for (let i = 1; i < extrusions.length; i++) {
      const fuseResult = BooleanOps.fuseMultiShapeWithCleanup([fused], [extrusions[i]]);
      console.log(`Fusing shape ${i}`, "New shapes:", fuseResult.newShapes.length, "Modified shapes:", fuseResult.modifiedShapes.length);
      modifiedShapes.push(...fuseResult.modifiedShapes);

      if (modifiedShapes.length == 0) {
        newShapes.push(fused);
        newShapes.push(extrusions[i]);
      }
      else {
        newShapes.push(...fuseResult.newShapes);
      }

      fused = newShapes[newShapes.length - 1];
    }

    console.log("Fused shape count:", newShapes.length);
    console.log("Modified shape count:", modifiedShapes.length);

  }
  else {
    const result = BooleanOps.fuseMultiShapeWithCleanup(args, extrusions);
    newShapes = result.newShapes;
    modifiedShapes = result.modifiedShapes;
  }


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
