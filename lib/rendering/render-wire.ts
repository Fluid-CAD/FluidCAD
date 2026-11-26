import { renderEdge } from "./render-edge.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { Mesh } from "../oc/mesh.js";
import type { MeshConfig } from "../oc/mesh.js";
import type { SceneObjectMesh } from "./scene.js";

/**
 * One line mesh per edge of a wire, each carrying the edge's index in
 * `getIndexedShapes('edge')` (explorer order, the order the hit test and the
 * selection resolver count in), so every edge of a curve can be picked and
 * highlighted on its own.
 */
export function renderWire(shapeObj: Shape, meshConfig?: MeshConfig): SceneObjectMesh[] {
  Mesh.ensureTriangulated(shapeObj.getShape(), meshConfig);

  const meshes: SceneObjectMesh[] = [];
  // The explorer wrappers are this pass's temporaries, walked as
  // `getIndexedShapes` walks them; the wire keeps its own edge wrappers.
  const edges = Explorer.findEdgesWrapped(shapeObj);
  try {
    edges.forEach((edge, edgeIndex) => {
      const edgeResult = renderEdge(edge);
      if (edgeResult && edgeResult.indices.length > 0) {
        meshes.push({ ...edgeResult, edgeIndex });
      }
    });
  } finally {
    for (const edge of edges) edge.dispose();
  }
  return meshes;
}
