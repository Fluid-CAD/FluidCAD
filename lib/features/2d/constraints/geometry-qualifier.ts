import { SceneObject } from "../../../common/scene-object.js";
import { QualifiedSceneObject } from "./qualified-geometry.js";

export function outside(sceneObject: SceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject, 'outside');
}

export function enclosed(sceneObject: SceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject, 'enclosed');
}

export function enclosing(sceneObject: SceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject, 'enclosing');
}

export function unqualified(sceneObject: SceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject, 'unqualified');
}
