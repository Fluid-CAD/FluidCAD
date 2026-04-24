import { SceneObjectMesh } from "./scene.js";
import { Matrix4 } from "../math/matrix4.js";

export function transformMeshes(meshes: SceneObjectMesh[], matrix: Matrix4): SceneObjectMesh[] {
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
    if (flipWinding && mesh.indices.length % 3 === 0) {
      newIndices = new Array<number>(mesh.indices.length);
      for (let i = 0; i < mesh.indices.length; i += 3) {
        newIndices[i]     = mesh.indices[i];
        newIndices[i + 1] = mesh.indices[i + 2];
        newIndices[i + 2] = mesh.indices[i + 1];
      }
    }

    return { ...mesh, vertices: newV, normals: newN, indices: newIndices };
  });
}
