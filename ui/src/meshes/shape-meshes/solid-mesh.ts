import { Group } from 'three';
import { MeshRenderOptions, SceneObjectPart } from '../../types';
import { FaceMesh } from './face-mesh';
import { EdgeMesh } from './edge-mesh';

/**
 * A solid is represented as two sub-meshes: triangulated faces and edge line
 * segments.  The backend labels them `solid-faces` and `solid-edges` so we
 * can split them and apply independent materials / render order.
 */
export class SolidMesh extends Group {
  constructor(shape: SceneObjectPart, options?: MeshRenderOptions) {
    super();

    for (const meshData of shape.meshes) {
      if (meshData.label === 'solid-faces') {
        const faces = new FaceMesh({ shapeType: 'face', meshes: [meshData] }, options?.face);
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
