import { Matrix4 } from "../math/matrix4.js";
import { roundSide } from "../oc/edge-face-sides.js";

/**
 * What a transform touches: packed xyz vertices and normals, the triangle
 * indices it may re-wind, and an edge line's face sides.
 */
export type MeshArrays = { vertices: number[]; normals: number[]; indices: number[]; faceSides?: number[] };

/** `meshes` moved by `matrix` — wire meshes and cached face pieces alike; every other field is kept. */
export function transformMeshes<T extends MeshArrays>(meshes: T[], matrix: Matrix4): T[] {
  const m = matrix.elements;
  // Determinant of the 3x3 linear part. Negative for mirror/reflection
  // transforms — those flip triangle winding, so we have to swap indices
  // to keep faces front-facing after the vertex transform.
  const det3 =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6]  - m[5] * m[2]);
  const flipWinding = det3 < 0;

  return meshes.map(mesh => {
    const srcV = mesh.vertices;
    const srcN = mesh.normals;
    const newV = new Array<number>(srcV.length);
    const newN = new Array<number>(srcN.length);

    for (let i = 0; i < srcV.length; i += 3) {
      const x = srcV[i], y = srcV[i + 1], z = srcV[i + 2];
      newV[i]     = m[0] * x + m[4] * y + m[8]  * z + m[12];
      newV[i + 1] = m[1] * x + m[5] * y + m[9]  * z + m[13];
      newV[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }

    for (let i = 0; i < srcN.length; i += 3) {
      const nx = srcN[i], ny = srcN[i + 1], nz = srcN[i + 2];
      newN[i]     = m[0] * nx + m[4] * ny + m[8]  * nz;
      newN[i + 1] = m[1] * nx + m[5] * ny + m[9]  * nz;
      newN[i + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
    }

    let newIndices = mesh.indices;
    // Triangles only: an edge line's index pairs (which `faceSides` marks)
    // keep their segments' directions.
    if (flipWinding && mesh.indices.length % 3 === 0 && !mesh.faceSides) {
      newIndices = new Array<number>(mesh.indices.length);
      for (let i = 0; i < mesh.indices.length; i += 3) {
        newIndices[i]     = mesh.indices[i];
        newIndices[i + 1] = mesh.indices[i + 2];
        newIndices[i + 2] = mesh.indices[i + 1];
      }
    }

    if (!mesh.faceSides) {
      return { ...mesh, vertices: newV, normals: newN, indices: newIndices };
    }

    // Vectors along the faces: the linear part moves them as it moves the
    // faces (a mirror included — the face stays on the side it was), and
    // scales their reach with them. A mirror also turns the pair's
    // handedness, which carries the edge's convexity: swap the two back.
    const srcS = mesh.faceSides;
    const newS = new Array<number>(srcS.length);
    for (let i = 0; i < srcS.length; i += 3) {
      const sx = srcS[i], sy = srcS[i + 1], sz = srcS[i + 2];
      const [x, y, z] = roundSide(
        m[0] * sx + m[4] * sy + m[8]  * sz,
        m[1] * sx + m[5] * sy + m[9]  * sz,
        m[2] * sx + m[6] * sy + m[10] * sz,
      );
      const o = flipWinding ? (i % 6 === 0 ? i + 3 : i - 3) : i;
      newS[o]     = x;
      newS[o + 1] = y;
      newS[o + 2] = z;
    }
    return { ...mesh, vertices: newV, normals: newN, indices: newIndices, faceSides: newS };
  });
}
