import { Explorer } from "../oc/explorer.js";
import { Shape } from "../common/shape.js";
import { SceneObjectMesh } from "./scene.js";
import { Mesh } from "../oc/mesh.js";
import { getOC } from "../oc/init.js";

export function renderSolid(shapeObj: Shape): SceneObjectMesh[] {
  Mesh.ensureTriangulated(shapeObj.getShape());

  const facesMeshes = getFacesMesh(shapeObj);
  const edgesMesh = getEdgesMesh(shapeObj);

  return [...facesMeshes, ...edgesMesh];
}

function getEdgesMesh(shapeObj: Shape): SceneObjectMesh[] {
  const oc = getOC();
  const result: SceneObjectMesh[] = [];

  const edgeToFaces = new oc.TopTools_IndexedDataMapOfShapeListOfShape();
  oc.TopExp.MapShapesAndAncestors(
    shapeObj.getShape(),
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    edgeToFaces,
  );

  const edges = Explorer.findEdgesWrapped(shapeObj);

  for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
    const edgeShape = edges[edgeIdx].getShape();

    const parents = edgeToFaces.Seek(edgeShape);
    if (!parents || parents.Size() === 0) {
      continue;
    }

    const parentFace = oc.TopoDS.Face(parents.First());
    const edgeResult = Mesh.discretizeEdgeOnFace(edgeShape, parentFace);
    parentFace.delete();

    if (edgeResult) {
      result.push({
        ...edgeResult,
        label: 'solid-edges',
        edgeIndex: edgeIdx,
      });
    }
  }

  edgeToFaces.delete();
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
