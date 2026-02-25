import { Shape } from "../common/shape.js";
import { Mesh } from "../oc/mesh.js";
import type { SceneObjectMesh } from "./scene.js";

export function renderEdge(edgeObj: Shape): SceneObjectMesh {
  return Mesh.discretizeEdge(edgeObj);
}
