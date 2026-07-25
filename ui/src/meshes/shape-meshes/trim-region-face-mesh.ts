import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { SceneObjectPart } from '../../types';

/**
 * Renders a trim-region meta face: an invisible but raycastable fill for the
 * trim dialog's By Region mode. The region's metaData (the ids of the split
 * segments bounding it) rides on userData; hovering highlights those
 * segments (the fill itself stays invisible), clicking trims them.
 */
export class TrimRegionFaceMesh extends Group {
  constructor(shape: SceneObjectPart) {
    super();
    this.userData.isMetaShape = true;
    this.userData.isTrimRegion = true;
    if (shape.metaData) {
      this.userData.metaData = shape.metaData;
    }

    for (const meshData of shape.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(meshData.normals), 3));
      const IndexArray = meshData.vertices.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geometry.setIndex(new BufferAttribute(new IndexArray(meshData.indices), 1));
      geometry.computeBoundingBox();

      const material = new MeshBasicMaterial({
        color: '#ffc578',
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });

      this.add(new Mesh(geometry, material));
    }
  }
}
