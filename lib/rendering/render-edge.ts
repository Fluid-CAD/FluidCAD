import { Shape } from "../common/shape.js";
import { Mesh } from "../oc/mesh.js";
import type { MeshConfig } from "../oc/mesh.js";
import type { SceneObjectMesh } from "./scene.js";

export function renderEdge(edgeObj: Shape, meshConfig?: MeshConfig): SceneObjectMesh {
  return Mesh.discretizeEdge(edgeObj, meshConfig);
}
