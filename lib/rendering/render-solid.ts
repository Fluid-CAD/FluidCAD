import { renderFace } from "./render-face.js";
import { renderEdge } from "./render-edge.js";
import { Explorer } from "../oc/explorer.js";
import { Shape } from "../common/shape.js";
import { SceneObjectMesh } from "./scene.js";

export function renderSolid(shapeObj: Shape): SceneObjectMesh[] {
  const facesMeshes = getFacesMesh(shapeObj);
  const edgesMesh = getEdgesMesh(shapeObj);

  return [...facesMeshes, ...edgesMesh];
}

function getEdgesMesh(shapeObj: Shape) {
  const result: SceneObjectMesh[] = [];

  const edges = Explorer.findEdgesWrapped(shapeObj);

  for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
    const edgeResult = renderEdge(edges[edgeIdx]);
    if (edgeResult) {
      edgeResult.label = 'solid-edges';
      edgeResult.edgeIndex = edgeIdx;
      result.push(edgeResult);
    }
  }

  return result;
}

function getFacesMesh(shapeObj: Shape): SceneObjectMesh[] {
  const faces = Explorer.findFacesWrapped(shapeObj);

  const groups = new Map<string | undefined, { vertices: number[]; normals: number[]; indices: number[]; faceMapping: number[]; vertexOffset: number }>();

  for (let faceIdx = 0; faceIdx < faces.length; faceIdx++) {
    const face = faces[faceIdx];
    const color = shapeObj.getColor(face.getShape());

    const faceResult = renderFace(face, 0);

    if (faceResult) {
      if (!groups.has(color)) {
        groups.set(color, { vertices: [], normals: [], indices: [], faceMapping: [], vertexOffset: 0 });
      }
      const group = groups.get(color)!;

      const triangleCount = faceResult.indices.length / 3;
      for (let t = 0; t < triangleCount; t++) {
        group.faceMapping.push(faceIdx);
      }

      group.vertices.push(...faceResult.vertices);
      group.normals.push(...faceResult.normals);
      for (const idx of faceResult.indices) {
        group.indices.push(group.vertexOffset + idx);
      }
      group.vertexOffset += faceResult.count;
    }
  }

  const result: SceneObjectMesh[] = [];
  for (const [color, group] of groups) {
    const mesh: SceneObjectMesh = {
      vertices: group.vertices,
      normals: group.normals,
      indices: group.indices,
      faceMapping: group.faceMapping,
      label: "solid-faces",
    };

    if (color) {
      mesh.color = color;
    }
    result.push(mesh);
  }

  return result;
}
