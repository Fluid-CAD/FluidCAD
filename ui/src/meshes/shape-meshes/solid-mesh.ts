import { Group } from 'three';
import { MeshRenderOptions, SceneObjectMesh, SceneObjectPart } from '../../types';
import { FaceMesh } from './face-mesh';
import { EdgeMesh } from './edge-mesh';
import type { GrainAxis } from '../appearance/appearance-material';

/** The axis of the solid's longest extent over its face groups — x when they carry no vertices. */
function longestAxisOf(meshes: SceneObjectMesh[]): GrainAxis {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    if (mesh.label !== 'solid-faces') {
      continue;
    }
    const v = mesh.vertices;
    for (let i = 0; i + 2 < v.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (v[i + k] < min[k]) min[k] = v[i + k];
        if (v[i + k] > max[k]) max[k] = v[i + k];
      }
    }
  }
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!Number.isFinite(extent[0])) {
    return 'x';
  }
  if (extent[0] >= extent[1] && extent[0] >= extent[2]) return 'x';
  return extent[1] >= extent[2] ? 'y' : 'z';
}

/**
 * A solid is represented as two sub-meshes: triangulated faces and edge line
 * segments.  The backend labels them `solid-faces` and `solid-edges` so we
 * can split them and apply independent materials / render order.
 */
export class SolidMesh extends Group {
  constructor(shape: SceneObjectPart, options?: MeshRenderOptions) {
    super();
    // What "solids only" screenshots keep (see screenshot.ts isolateSolids).
    this.userData.isSolid = true;

    // A wood appearance's grain runs along the body's longest extent, read
    // over every face group so a painted group does not skew it.
    const grainAxis = options?.appearance?.wood ? longestAxisOf(shape.meshes) : undefined;
    for (const meshData of shape.meshes) {
      if (meshData.label === 'solid-faces') {
        const faces = new FaceMesh({ shapeType: 'face', meshes: [meshData] }, options?.face, options?.appearance, grainAxis);
        faces.renderOrder = 1;
        this.add(faces);
      } else if (meshData.label === 'solid-edges') {
        const edges = new EdgeMesh({ shapeType: 'edge', meshes: [meshData] }, options?.edge);
        edges.renderOrder = 2;
        this.add(edges);
      }
    }
  }
}
