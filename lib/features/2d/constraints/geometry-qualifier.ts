import { SceneObject } from "../../../common/scene-object.js";
import { ISceneObject } from "../../../core/interfaces.js";
import { QualifiedSceneObject } from "./qualified-geometry.js";

export function outside(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'outside');
}

export function enclosed(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'enclosed');
}

export function enclosing(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'enclosing');
}

export function unqualified(sceneObject: ISceneObject): QualifiedSceneObject {
  return new QualifiedSceneObject(sceneObject as SceneObject, 'unqualified');
}
