import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
} from 'three';
import { SceneObjectPart } from '../../types';

const COLOR = '#2297ff';
const LINE_WIDTH = 2;

/**
 * Renders trim-helper meta edges as solid blue lines matching regular sketch
 * edge styling. Uses LineSegments with LineBasicMaterial so that the standard
 * `highlightShape` logic works without modifications.
 */
export class TrimMetaEdgeMesh extends Group {
  constructor(shape: SceneObjectPart) {
    super();
    this.userData.isMetaShape = true;

    for (const meshData of shape.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(meshData.normals), 3));
      const IndexArray = meshData.vertices.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geometry.setIndex(new BufferAttribute(new IndexArray(meshData.indices), 1));

      const material = new LineBasicMaterial({
        color: COLOR,
        linewidth: LINE_WIDTH,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: DoubleSide,
        depthWrite: true,
        depthTest: true,
      });

      const ls = new LineSegments(geometry, material);
      this.add(ls);
    }
  }
}
