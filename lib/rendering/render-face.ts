import type { TopoDS_Face } from "ocjs-fluidcad";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { Mesh } from "../oc/mesh.js";
import type { MeshConfig } from "../oc/mesh.js";
import { SceneObjectMesh } from "./scene.js";

export function renderFace(faceObj: Shape, vertexOffset: number = 0, meshConfig?: MeshConfig) {
  const face = faceObj.getShape();
  return Mesh.triangulateFaceRaw(face, vertexOffset, meshConfig);
}

/**
 * A lone face rendered the way a solid is — a `solid-faces` mesh plus one
 * `solid-edges` mesh per boundary edge. Plain {@link renderFace} returns an
 * unlabeled triangulation, which the UI's `SolidMesh` skips entirely (it
 * splits its input on those two labels), so a face that has to draw on its own
 * comes through here instead. The outline is what makes a surface patch read
 * as a shape rather than a smear of translucency.
 */
export function renderFacePatch(faceObj: Shape, meshConfig?: MeshConfig): SceneObjectMesh[] {
  const face = faceObj.getShape();
  Mesh.ensureTriangulated(face, meshConfig);

  const meshes: SceneObjectMesh[] = [];
  const triangulation = Mesh.extractFaceTriangulationRaw(face as TopoDS_Face, 0);
  if (!triangulation) {
    return meshes;
  }
  meshes.push({ ...triangulation, label: 'solid-faces' });

  const edges = Explorer.findEdgesWrapped(faceObj);
  try {
    edges.forEach((edge, index) => {
      const discretized = Mesh.discretizeEdgeOnFace(edge.getShape(), face as TopoDS_Face);
      if (discretized) {
        meshes.push({ ...discretized, label: 'solid-edges', edgeIndex: index });
      }
    });
  } finally {
    for (const edge of edges) {
      edge.dispose();
    }
  }
  return meshes;
}
