import { renderEdge } from "./render-edge.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "../oc/explorer.js";
import { Mesh } from "../oc/mesh.js";
import type { MeshConfig } from "../oc/mesh.js";

export function renderWire(shapeObj: Shape, meshConfig?: MeshConfig) {
  const shape = shapeObj.getShape();

  Mesh.ensureTriangulated(shape, meshConfig);

  const allVertices: number[] = [];
  const allNormals: number[] = [];
  const allIndices: number[] = [];

  // The explorer copies and the wrapper each edge is read through are this
  // mesh's own; nothing keeps them past its tessellation.
  Explorer.withShapes(shape, Explorer.getOcShapeType("edge"), edges => {
    for (const current of edges) {
      const edge = Edge.fromTopoDSEdge(Explorer.toEdge(current));
      try {
        const edgeResult = renderEdge(edge);
        if (edgeResult) {
          const vertexOffset = allVertices.length / 3;
          allVertices.push(...edgeResult.vertices);
          allNormals.push(...edgeResult.normals);
          for (let i = 0; i < edgeResult.indices.length; i++) {
            allIndices.push(edgeResult.indices[i] + vertexOffset);
          }
        }
      } finally {
        edge.dispose();
      }
    }
  });

  return {
    vertices: allVertices,
    normals: allNormals,
    indices: allIndices
  }
}
