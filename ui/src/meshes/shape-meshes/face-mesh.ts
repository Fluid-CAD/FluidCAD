import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshPhongMaterial,
} from 'three';
import { FaceMeshOptions, SceneObjectPart } from '../../types';
import { themeColors } from '../../scene/theme-colors';

const DEFAULTS: Required<FaceMeshOptions> = {
  color: '',
  opacity: 1,
};

export class FaceMesh extends Group {
  constructor(shape: SceneObjectPart, options: FaceMeshOptions = {}) {
    super();
    const opts = { ...DEFAULTS, ...options };

    for (const meshData of shape.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(meshData.normals), 3));
      const IndexArray = meshData.vertices.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geometry.setIndex(new BufferAttribute(new IndexArray(meshData.indices), 1));
      geometry.computeBoundingBox();

      const faceColor = options?.color ?? meshData.color ?? '#' + themeColors.faceColor.getHexString();

      const isOverlay = options?.color !== undefined || options?.opacity !== undefined;
      const material = new MeshPhongMaterial({
        color: faceColor,
        transparent: isOverlay || opts.opacity < 1,
        opacity: opts.opacity,
        depthWrite: !isOverlay,
        polygonOffset: true,
        polygonOffsetFactor: isOverlay ? -1 : 1,
        polygonOffsetUnits: 1,
        side: DoubleSide
      });

      const mesh = new Mesh(geometry, material);
      if (meshData.faceMapping) {
        mesh.userData.faceMapping = meshData.faceMapping;
      }

      this.add(mesh);
    }
  }
}
