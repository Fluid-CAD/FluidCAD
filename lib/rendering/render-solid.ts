import type { TopoDS_Face, TopoDS_Shape, TopTools_IndexedMapOfShape } from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { SceneObjectMesh } from "./scene.js";
import { Mesh } from "../oc/mesh.js";
import type { EdgeFace, MeshConfig } from "../oc/mesh.js";
import { FaceFacets } from "../oc/edge-face-sides.js";
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

  const faces = getFacePieces(shapeObj);
  return { faces, meshes: getEdgesMesh(shapeObj, faces) };
}

/**
 * The solid's edge lines, each read on the faces it bounds: the face pieces
 * already hold every face's triangulation, so an edge's `faceSides` (see
 * `Mesh.discretizeSolidEdge`) cost no second read of it.
 */
function getEdgesMesh(shapeObj: Shape, facePieces: FacePiece[]): SceneObjectMesh[] {
  const oc = getOC();
  const result: SceneObjectMesh[] = [];

  const edgeToFaces = (shapeObj as Solid).getEdgeToFacesIndex();
  const facets = new SolidFacets(shapeObj.getShape(), facePieces);

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

      // `parents` is the index's own list (a pointer, never deleted);
      // First()/Last() hand back copies that are.
      const first = parents.First();
      const parentFace = oc.TopoDS.Face(first);
      // The second face, when there is one and it is not the first again (a
      // seam): with both, the line knows the face on each of its sides.
      let otherFace: TopoDS_Face | null = null;
      if (parents.Size() >= 2) {
        const last = parents.Last();
        if (!first.IsSame(last)) {
          otherFace = oc.TopoDS.Face(last);
        }
        last.delete();
      }
      let edgeResult: ReturnType<typeof Mesh.discretizeEdgeOnFace>;
      try {
        const edgeFaces = facets.edgeFaces(parentFace, otherFace);
        edgeResult = edgeFaces
          ? Mesh.discretizeSolidEdge(edgeShape, edgeFaces)
          : Mesh.discretizeEdgeOnFace(edgeShape, parentFace);
      } finally {
        parentFace.delete();
        otherFace?.delete();
      }

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
        if (parents.Size() === 2) {
          const last = parents.Last();
          const typedEdge = oc.TopoDS.Edge(edgeShape);
          try {
            if (!first.IsSame(last) && EdgeConvexityOps.isSmoothRaw(typedEdge, first, last)) {
              mesh.smooth = true;
            }
          } finally {
            typedEdge.delete();
            last.delete();
          }
        }
        result.push(mesh);
      }
      first.delete();
    }
  } finally {
    facets.delete();
    hidden?.delete();
    spanSeams?.delete();
    // The explorer wrappers are this pass's temporaries; the solid keeps its
    // own edge wrappers (`getIndexedShapes`).
    for (const edge of edges) edge.dispose();
  }

  return result;
}

/**
 * A solid's face triangulations by face, for its edges: the face pieces
 * (Explorer order) located through a face map built the same way, and each
 * face's {@link FaceFacets} made on first use.
 */
class SolidFacets {
  private readonly faceIndex: TopTools_IndexedMapOfShape;
  private readonly pieces = new Map<number, FacePiece>();
  private readonly facets = new Map<number, FaceFacets>();

  constructor(shape: TopoDS_Shape, pieces: FacePiece[]) {
    const oc = getOC();
    // TopExp::MapShapes visits faces in the explorer's first-seen order —
    // the order `Explorer.findFacesWrapped` numbers the pieces by.
    this.faceIndex = new oc.TopTools_IndexedMapOfShape();
    oc.TopExp.MapShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, this.faceIndex);
    for (const piece of pieces) {
      this.pieces.set(piece.faceIdx, piece);
    }
  }

  /** `first` (and `second`, when given) with their facets; null when `first` has no piece. A `second` without one is left out. */
  edgeFaces(first: TopoDS_Face, second: TopoDS_Face | null): EdgeFace[] | null {
    const firstFacets = this.facetsOf(first);
    if (!firstFacets) {
      return null;
    }
    const faces: EdgeFace[] = [{ face: first, facets: firstFacets }];
    const secondFacets = second ? this.facetsOf(second) : null;
    if (second && secondFacets) {
      faces.push({ face: second, facets: secondFacets });
    }
    return faces;
  }

  private facetsOf(face: TopoDS_Face): FaceFacets | null {
    const faceIdx = this.faceIndex.FindIndex(face) - 1;
    let facets = this.facets.get(faceIdx);
    if (!facets) {
      const piece = this.pieces.get(faceIdx);
      if (!piece) {
        return null;
      }
      facets = new FaceFacets(piece.vertices, piece.indices);
      this.facets.set(faceIdx, facets);
    }
    return facets;
  }

  delete(): void {
    this.faceIndex.delete();
  }
}

function getFacePieces(shapeObj: Shape): FacePiece[] {
  const faces = Explorer.findFacesWrapped(shapeObj);
  const pieces: FacePiece[] = [];

  try {
    for (let faceIdx = 0; faceIdx < faces.length; faceIdx++) {
      const faceResult = Mesh.extractFaceTriangulationRaw(faces[faceIdx].getShape(), 0);
      if (faceResult) {
        pieces.push({ faceIdx, vertices: faceResult.vertices, normals: faceResult.normals, indices: faceResult.indices });
      }
    }
  } finally {
    for (const face of faces) face.dispose();
  }

  return pieces;
}
