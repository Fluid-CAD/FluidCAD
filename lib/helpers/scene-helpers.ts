import { SceneObject } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Plane } from "../math/plane.js";
import { classifyCutResult } from "./cut-helpers.js";

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

export function cutWithSceneObjects(
  sceneObjects: SceneObject[],
  toolShapes: Shape[],
  plane: Plane,
  distance: number,
  caller: SceneObject
): { cleanedShapes: Shape[], stockShapes: Shape[] } {
  const sceneObjectMap = new Map<SceneObject, Shape[]>();
  for (const obj of sceneObjects) {
    const shapes = obj.getShapes({}, 'solid');
    if (shapes.length === 0) {
      continue;
    }
    sceneObjectMap.set(obj, shapes);
  }

  const shapeObjectMap = new Map<Shape, SceneObject>();
  for (const [obj, shapes] of sceneObjectMap) {
    for (const shape of shapes) {
      shapeObjectMap.set(shape, obj);
    }
  }

  const stock = Array.from(shapeObjectMap.keys());
  const cutResult = BooleanOps.cutMultiShape(stock, toolShapes, plane, distance);

  const cleanedShapes: Shape[] = [];
  for (const shape of stock) {
    const list = cutResult.modified(shape);
    if (list.length) {
      for (const newShape of list) {
        const s = ShapeOps.cleanShape(newShape) as Solid;
        caller.addShape(s);
        cleanedShapes.push(s);
      }

      const obj = shapeObjectMap.get(shape);
      obj.removeShape(shape, caller);
    }
  }

  classifyCutResult(caller, stock, cleanedShapes, plane, distance);

  return { cleanedShapes, stockShapes: stock };
}
