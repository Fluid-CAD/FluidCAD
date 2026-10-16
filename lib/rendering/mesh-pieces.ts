import type { SceneObjectMesh } from "./scene.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { FaceColorView } from "../common/face-color-view.js";
import type { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Explorer } from "../oc/explorer.js";
import { transformMeshes } from "./mesh-transform.js";

/** One face's triangulation, in the solid's face (Explorer) order. */
export type FacePiece = {
  faceIdx: number;
  vertices: number[];
  normals: number[];
  indices: number[];
};

/**
 * The scope-free geometry cache of one shape: a solid's faces one piece
 * each, to be grouped by colour per render pass, plus the meshes drawn as
 * they are (a solid's edges; every mesh of a face, wire, edge or vertex).
 * Colour is not baked in: the same wrapper shows in different colours in
 * different passes (a rollback before its paint, between two paints).
 */
export type ShapeMeshPieces = {
  faces: FacePiece[];
  meshes: SceneObjectMesh[];
};

export class MeshPieces {
  /** Pieces for a shape whose meshes carry no colour (anything but a solid). */
  static ofMeshes(meshes: SceneObjectMesh[]): ShapeMeshPieces {
    return { faces: [], meshes };
  }

  /** A moved copy's pieces: the source's, transformed — face order is the source's, as `faceMapping` already assumes. */
  static transform(pieces: ShapeMeshPieces, matrix: Matrix4): ShapeMeshPieces {
    return {
      faces: transformMeshes(pieces.faces, matrix),
      meshes: transformMeshes(pieces.meshes, matrix),
    };
  }

  /**
   * The wire meshes of one pass: one `solid-faces` mesh per resolved colour
   * (`faceMapping` per triangle, `color` set when painted) followed by the
   * plain meshes. Without a view, or with an empty one, every face lands in
   * one unpainted mesh and `shape` is never opened.
   */
  static group(pieces: ShapeMeshPieces, colors?: FaceColorView, shape?: Shape): SceneObjectMesh[] {
    const colorOf = MeshPieces.colorLookup(pieces, colors, shape);
    const groups = new Map<string | undefined, SceneObjectMesh>();
    const vertexOffsets = new Map<string | undefined, number>();

    for (const piece of pieces.faces) {
      const color = colorOf(piece.faceIdx);
      let group = groups.get(color);
      if (!group) {
        group = { vertices: [], normals: [], indices: [], faceMapping: [], label: "solid-faces" };
        if (color) {
          group.color = color;
        }
        groups.set(color, group);
        vertexOffsets.set(color, 0);
      }
      const vertexOffset = vertexOffsets.get(color)!;

      const triangleCount = piece.indices.length / 3;
      for (let t = 0; t < triangleCount; t++) {
        group.faceMapping!.push(piece.faceIdx);
      }
      // No spread: JS argument counts are capped (~65K) and a big face
      // would throw "Maximum call stack size exceeded".
      const verts = piece.vertices;
      for (let i = 0; i < verts.length; i++) {
        group.vertices.push(verts[i]);
      }
      const norms = piece.normals;
      for (let i = 0; i < norms.length; i++) {
        group.normals.push(norms[i]);
      }
      for (const idx of piece.indices) {
        group.indices.push(vertexOffset + idx);
      }
      vertexOffsets.set(color, vertexOffset + verts.length / 3);
    }

    const result: SceneObjectMesh[] = [...groups.values()];
    for (const mesh of pieces.meshes) {
      result.push(mesh);
    }
    return result;
  }

  /** Face index → resolved colour, reading `shape`'s faces only when there is something to resolve. */
  private static colorLookup(
    pieces: ShapeMeshPieces,
    colors: FaceColorView | undefined,
    shape: Shape | undefined,
  ): (faceIdx: number) => string | undefined {
    if (!colors || colors.isEmpty() || !shape || pieces.faces.length === 0) {
      return () => undefined;
    }
    const faces = shape instanceof Solid ? shape.getFaces() : Explorer.findFacesWrapped(shape);
    return faceIdx => {
      const face = faces[faceIdx];
      return face ? colors.get(face.getShape()) : undefined;
    };
  }
}
