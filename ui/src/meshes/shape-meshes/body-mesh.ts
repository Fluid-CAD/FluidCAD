import { Group } from 'three';
import { MeshRenderOptions, SceneObjectMesh, SceneObjectPart } from '../../types';
import { themeColors } from '../../scene/theme-colors';
import { FaceMesh } from './face-mesh';
import { EdgeMesh } from './edge-mesh';
import type { GrainAxis } from '../appearance/appearance-material';

/** The kind of body drawn: a solid, or a surface (connected faces that need not close). */
export type BodyKind = 'solid' | 'surface';

export type BodyMeshOptions = MeshRenderOptions & { body?: BodyKind };

/** The axis of the body's longest extent over its face groups — x when they carry no vertices. */
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
 * A body — a solid or a surface — is represented as two sub-meshes:
 * triangulated faces and edge line segments. The backend labels them
 * `solid-faces` and `solid-edges` (for either kind) so we can split them and
 * apply independent materials / render order.
 *
 * The group says which kind it draws: `userData.isSolid` for a solid, which
 * the solid-only readers (section caps, the interference overlay) rely on,
 * and `userData.isSurface` for a surface, which picking reads to take its back
 * side as a front. Readers of "model geometry" take both.
 */
export class BodyMesh extends Group {
  constructor(shape: SceneObjectPart, options?: BodyMeshOptions) {
    super();
    const surface = options?.body === 'surface';
    if (surface) {
      this.userData.isSurface = true;
    } else {
      this.userData.isSolid = true;
    }

    // A wood appearance's grain runs along the body's longest extent, read
    // over every face group so a painted group does not skew it.
    const grainAxis = options?.appearance?.wood ? longestAxisOf(shape.meshes) : undefined;
    // An older engine's edges carry no face sides and draw at their
    // centerline depth: the faces keep the slope offset that kept them in
    // front (see face-depth-offset.ts).
    const edges = shape.meshes.filter(m => m.label === 'solid-edges');
    // A surface's unpainted faces rest in their own theme colour.
    const restColor = surface ? '#' + themeColors.surfaceFace.getHexString() : undefined;
    // A body's geometry is never rewritten in place: every object drawing
    // the same mesh shares one geometry (the page's mesh cache, P6).
    const faceOptions = edges.length > 0 && !edges.some(m => m.faceSides?.length)
      ? { restColor, ...options?.face, slopeOffset: true, sharedGeometry: true }
      : { restColor, ...options?.face, sharedGeometry: true };
    const edgeOptions = { ...options?.edge, sharedGeometry: true };
    for (const meshData of shape.meshes) {
      if (meshData.label === 'solid-faces') {
        const faces = new FaceMesh({ shapeType: 'face', meshes: [meshData] }, faceOptions, options?.appearance, grainAxis);
        faces.renderOrder = 1;
        this.add(faces);
      } else if (meshData.label === 'solid-edges') {
        const edges = new EdgeMesh({ shapeType: 'edge', meshes: [meshData] }, edgeOptions);
        edges.renderOrder = 2;
        this.add(edges);
      }
    }
  }
}
