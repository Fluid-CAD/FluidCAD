import type { TopoDS_Face, TopoDS_Shape, TopTools_IndexedMapOfShape } from "ocjs-fluidcad";
import { Explorer } from "../oc/explorer.js";
import type { BodyShape } from "../common/body-shape.js";
import { SceneObjectMesh } from "./scene.js";
import { Mesh } from "../oc/mesh.js";
import type { EdgeFace, MeshConfig } from "../oc/mesh.js";
import { FaceFacets } from "../oc/edge-face-sides.js";
import { getOC } from "../oc/init.js";
import { EdgeConvexityOps } from "../oc/edge-convexity.js";
import { TopologyIndex } from "../oc/topology-index.js";
import type { FaceColorView } from "../common/face-color-view.js";
import { MeshPieces, type FacePiece, type ShapeMeshPieces } from "./mesh-pieces.js";

/**
 * Meshes a body — a solid or a surface — for one pass: its faces grouped by
 * colour (one `solid-faces` mesh per colour, `colors` resolving each face —
 * none means unpainted) and its edges.
 */
export function renderBody(body: BodyShape, meshConfig?: MeshConfig, colors?: FaceColorView): SceneObjectMesh[] {
  return MeshPieces.group(renderBodyPieces(body, meshConfig), colors, body);
}

/**
 * The scope-free geometry of a body: one piece per face, in Explorer
 * order, and its edge meshes. Colour is resolved when the pieces are
 * grouped for a pass (`MeshPieces.group`), never here.
 */
export function renderBodyPieces(body: BodyShape, meshConfig?: MeshConfig): ShapeMeshPieces {
  Mesh.ensureTriangulated(body.getShape(), meshConfig);

  const faces = getFacePieces(body);
  return { faces, meshes: getEdgesMesh(body, faces) };
}

/**
 * The body's edge lines, each read on the faces it bounds: the face pieces
 * already hold every face's triangulation, so an edge's `faceSides` (see
 * `Mesh.discretizeSolidEdge`) cost no second read of it.
 */
function getEdgesMesh(body: BodyShape, facePieces: FacePiece[]): SceneObjectMesh[] {
  const oc = getOC();
  const result: SceneObjectMesh[] = [];

  const edgeToFaces = body.getEdgeToFacesIndex();
  const facets = new BodyFacets(body.getShape(), facePieces);

  const edges = Explorer.findEdgesWrapped(body);
  const spanSeams = body.getRenderSeams().length
    ? TopologyIndex.buildShapeSet([...body.getRenderSeams()]) : null;

  try {
    for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
      const edgeShape = edges[edgeIdx].getShape();
      // Native seams, degenerate edges and recorded sweep construction joins
      // are not drawn. Raw indexing remains unchanged for explicit lookups.
      if (body.isHiddenEdge(edgeShape) || spanSeams?.Contains(edgeShape)) {
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
        // An edge only one face bounds is the open rim of a surface: the UI
        // draws it in the rim style. A closed solid has none, and a seam is
        // hidden above. The body's own rule, which edge().boundary() and the
        // boundaryEdges() bucket read too.
        if (body.isBoundaryEdge(edgeShape)) {
          mesh.boundary = true;
        }
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
    spanSeams?.delete();
    // The explorer wrappers are this pass's temporaries; the body keeps its
    // own edge wrappers (`getIndexedShapes`).
    for (const edge of edges) edge.dispose();
  }

  return result;
}

/**
 * A body's face triangulations by face, for its edges: the face pieces
 * (Explorer order) located through a face map built the same way, and each
 * face's {@link FaceFacets} made on first use.
 */
class BodyFacets {
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

function getFacePieces(body: BodyShape): FacePiece[] {
  const faces = Explorer.findFacesWrapped(body);
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
