import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
} from 'three';
import { EdgeMeshOptions, SceneObjectPart } from '../../types';

const DEFAULTS: Required<EdgeMeshOptions> = {
  color: '#000000',
  lineWidth: 1,
  opacity: 1,
  depthWrite: true,
};

export class EdgeMesh extends Group {
  constructor(shape: SceneObjectPart, options: EdgeMeshOptions = {}) {
    super();
    const opts = { ...DEFAULTS, ...options };

    for (const meshData of shape.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(meshData.normals), 3));
      const IndexArray = meshData.vertices.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geometry.setIndex(new BufferAttribute(new IndexArray(meshData.indices), 1));

      const material = new LineBasicMaterial({
        color: opts.color,
        linewidth: opts.lineWidth,
        transparent: opts.opacity < 1,
        opacity: opts.opacity,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 1,
        side: DoubleSide,
        depthWrite: opts.depthWrite,
        depthTest: opts.depthWrite,
      });

      const ls = new LineSegments(geometry, material);
      if (meshData.edgeIndex !== undefined) {
        ls.userData.edgeIndex = meshData.edgeIndex;
      }
      this.add(ls);
    }
  }
}
