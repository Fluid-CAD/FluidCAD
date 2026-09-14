import type { TopoDS_Shape } from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { SceneObjectMesh } from "./scene.js";
import { Mesh } from "../oc/mesh.js";
import type { MeshConfig } from "../oc/mesh.js";
import { getOC } from "../oc/init.js";
import { HiddenEdges } from "../oc/hidden-edges.js";
import { EdgeConvexityOps } from "../oc/edge-convexity.js";

export function renderSolid(shapeObj: Shape, meshConfig?: MeshConfig): SceneObjectMesh[] {
  Mesh.ensureTriangulated(shapeObj.getShape(), meshConfig);

  const facesMeshes = getFacesMesh(shapeObj);
  const edgesMesh = getEdgesMesh(shapeObj);

  return [...facesMeshes, ...edgesMesh];
}

function getEdgesMesh(shapeObj: Shape): SceneObjectMesh[] {
  const oc = getOC();
  const result: SceneObjectMesh[] = [];

  const edgeToFaces = (shapeObj as Solid).getEdgeToFacesIndex();

  // Seams and degenerated edges are never drawn; `edgeIdx` still counts
  // them so the index matches every explorer-ordered lookup.
  const hidden = shapeObj instanceof Solid ? null : HiddenEdges.collect(shapeObj.getShape());
  const isHidden = (edge: TopoDS_Shape) => (shapeObj instanceof Solid ? shapeObj.isHiddenEdge(edge) : hidden!.Contains(edge));

  const edges = Explorer.findEdgesWrapped(shapeObj);

  try {
    for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
      const edgeShape = edges[edgeIdx].getShape();
      if (isHidden(edgeShape)) {
        continue;
      }

      const parents = edgeToFaces.Seek(edgeShape);
      if (!parents || parents.Size() === 0) {
        continue;
      }

      const parentFace = oc.TopoDS.Face(parents.First());
      const edgeResult = Mesh.discretizeEdgeOnFace(edgeShape, parentFace);
      parentFace.delete();

      if (edgeResult) {
        const mesh: SceneObjectMesh = {
          ...edgeResult,
          label: 'solid-edges',
          edgeIndex: edgeIdx,
        };
        // A junction where the two faces are tangent (a fillet's boundary, a
        // profile line running into its arc) marks no crease: the UI draws
        // it dimmed. Non-manifold edges (three or more faces) stay plain.
        if (parents.Size() === 2 && !parents.First().IsSame(parents.Last())
          && EdgeConvexityOps.classifyRaw(oc.TopoDS.Edge(edgeShape), parents.First(), parents.Last()) === 'smooth') {
          mesh.smooth = true;
        }
        result.push(mesh);
      }
    }
  } finally {
    hidden?.delete();
  }

  return result;
}

function getFacesMesh(shapeObj: Shape): SceneObjectMesh[] {
  const faces = Explorer.findFacesWrapped(shapeObj);

  const groups = new Map<string | undefined, { vertices: number[]; normals: number[]; indices: number[]; faceMapping: number[]; vertexOffset: number }>();

  for (let faceIdx = 0; faceIdx < faces.length; faceIdx++) {
    const face = faces[faceIdx];
    const color = shapeObj.getColor(face.getShape());

    const faceResult = Mesh.extractFaceTriangulationRaw(face.getShape(), 0);

    if (faceResult) {
      if (!groups.has(color)) {
        groups.set(color, { vertices: [], normals: [], indices: [], faceMapping: [], vertexOffset: 0 });
      }
      const group = groups.get(color)!;

      const triangleCount = faceResult.indices.length / 3;
      for (let t = 0; t < triangleCount; t++) {
        group.faceMapping.push(faceIdx);
      }

      // Avoid spread on potentially huge arrays — JS argument count is
      // capped (~65K) and would throw "Maximum call stack size exceeded".
      const verts = faceResult.vertices;
      for (let i = 0; i < verts.length; i++) {
        group.vertices.push(verts[i]);
      }
      const norms = faceResult.normals;
      for (let i = 0; i < norms.length; i++) {
        group.normals.push(norms[i]);
      }
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
