import { renderEdge } from "./render-edge.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "../oc/explorer.js";
import { Mesh } from "../oc/mesh.js";

export function renderWire(shapeObj: Shape) {
  const shape = shapeObj.getShape();

  Mesh.ensureTriangulated(shape);

  const edges = Explorer.findShapes(shape, Explorer.getOcShapeType("edge"));

  const allVertices: number[] = [];
  const allNormals: number[] = [];
  const allIndices: number[] = [];

  for (const current of edges) {
    const edge = Explorer.toEdge(current);
    const edgeResult = renderEdge(Edge.fromTopoDSEdge(edge));
    if (edgeResult) {
      const vertexOffset = allVertices.length / 3;
      allVertices.push(...edgeResult.vertices);
      allNormals.push(...edgeResult.normals);
      for (let i = 0; i < edgeResult.indices.length; i++) {
        allIndices.push(edgeResult.indices[i] + vertexOffset);
      }
    }
  }

  return {
    vertices: allVertices,
    normals: allNormals,
    indices: allIndices
  }
}
