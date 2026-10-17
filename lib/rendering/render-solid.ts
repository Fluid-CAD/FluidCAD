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
import { TopologyIndex } from "../oc/topology-index.js";
import type { FaceColorView } from "../common/face-color-view.js";
import { MeshPieces, type FacePiece, type ShapeMeshPieces } from "./mesh-pieces.js";

/**
 * Meshes a solid for one pass: its faces grouped by colour (one
 * `solid-faces` mesh per colour, `colors` resolving each face — none means
 * unpainted) and its edges.
 */
export function renderSolid(shapeObj: Shape, meshConfig?: MeshConfig, colors?: FaceColorView): SceneObjectMesh[] {
  return MeshPieces.group(renderSolidPieces(shapeObj, meshConfig), colors, shapeObj);
}

/**
 * The scope-free geometry of a solid: one piece per face, in Explorer
 * order, and its edge meshes. Colour is resolved when the pieces are
 * grouped for a pass (`MeshPieces.group`), never here.
 */
export function renderSolidPieces(shapeObj: Shape, meshConfig?: MeshConfig): ShapeMeshPieces {
  Mesh.ensureTriangulated(shapeObj.getShape(), meshConfig);

  return { faces: getFacePieces(shapeObj), meshes: getEdgesMesh(shapeObj) };
}

function getEdgesMesh(shapeObj: Shape): SceneObjectMesh[] {
  const oc = getOC();
  const result: SceneObjectMesh[] = [];

  const edgeToFaces = (shapeObj as Solid).getEdgeToFacesIndex();

  // Native seams, degenerate edges and recorded sweep construction joins
  // are not drawn. Raw indexing remains unchanged for explicit lookups.
  const hidden = shapeObj instanceof Solid ? null : HiddenEdges.collect(shapeObj.getShape());
  const isHidden = (edge: TopoDS_Shape) => (shapeObj instanceof Solid ? shapeObj.isHiddenEdge(edge) : hidden!.Contains(edge));

  const edges = Explorer.findEdgesWrapped(shapeObj);
  const spanSeams = shapeObj.getRenderSeams().length
    ? TopologyIndex.buildShapeSet([...shapeObj.getRenderSeams()]) : null;

  try {
    for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
      const edgeShape = edges[edgeIdx].getShape();
      if (isHidden(edgeShape) || spanSeams?.Contains(edgeShape)) {
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
        // profile line running into its arc) marks no crease: the UI can draw
        // it dimmed (the dimTangentEdges preference). Non-manifold edges
        // (three or more faces) stay unflagged.
        if (parents.Size() === 2 && !parents.First().IsSame(parents.Last())
          && EdgeConvexityOps.isSmoothRaw(oc.TopoDS.Edge(edgeShape), parents.First(), parents.Last())) {
          mesh.smooth = true;
        }
        result.push(mesh);
      }
    }
  } finally {
    hidden?.delete();
    spanSeams?.delete();
  }

  return result;
}

function getFacePieces(shapeObj: Shape): FacePiece[] {
  const faces = Explorer.findFacesWrapped(shapeObj);
  const pieces: FacePiece[] = [];

  for (let faceIdx = 0; faceIdx < faces.length; faceIdx++) {
    const faceResult = Mesh.extractFaceTriangulationRaw(faces[faceIdx].getShape(), 0);
    if (faceResult) {
      pieces.push({ faceIdx, vertices: faceResult.vertices, normals: faceResult.normals, indices: faceResult.indices });
    }
  }

  return pieces;
}
