import { SceneObject } from "../../../common/scene-object.js";
import { ISceneObject } from "../../../core/interfaces.js";
import { QualifiedSceneObject } from "./qualified-geometry.js";

/**
 * Qualifies a geometry as being on the outside of the constraining object.
 * @param sceneObject - The geometry to qualify.
 */
export function outside(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'outside');
}

/**
 * Qualifies a geometry as being enclosed by the constraining object.
 * @param sceneObject - The geometry to qualify.
 */
export function enclosed(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'enclosed');
}

/**
 * Qualifies a geometry as enclosing the constraining object.
 * @param sceneObject - The geometry to qualify.
 */
export function enclosing(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'enclosing');
}

/**
 * Removes any existing constraint qualification from a geometry.
 * @param sceneObject - The geometry to unqualify.
 */
export function unqualified(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'unqualified');
}
