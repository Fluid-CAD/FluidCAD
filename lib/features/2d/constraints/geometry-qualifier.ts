import { SceneObject } from "../../../common/scene-object.js";
import { QualifiedGeometry } from "./qualified-geometry.js";

export function outside(sceneObject: SceneObject): QualifiedGeometry {
  return new QualifiedGeometry(sceneObject, 'outside');
}

export function enclosed(sceneObject: SceneObject): QualifiedGeometry {
  return new QualifiedGeometry(sceneObject, 'enclosed');
}

export function enclosing(sceneObject: SceneObject): QualifiedGeometry {
  return new QualifiedGeometry(sceneObject, 'enclosing');
}

export function unqualified(sceneObject: SceneObject): QualifiedGeometry {
  return new QualifiedGeometry(sceneObject, 'unqualified');
}
