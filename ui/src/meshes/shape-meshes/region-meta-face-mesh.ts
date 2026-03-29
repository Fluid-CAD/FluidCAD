import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { SceneObjectPart } from '../../types';

const COLOR_UNSELECTED = '#2297ff';
const COLOR_SELECTED = '#4CAF50';
const OPACITY_UNSELECTED = 0.15;
const OPACITY_SELECTED = 0.4;

/**
 * Renders pick-region meta faces as semi-transparent colored surfaces.
 * Unselected regions are light blue; selected regions are green with higher opacity.
 */
export class RegionMetaFaceMesh extends Group {
  constructor(shape: SceneObjectPart, isSelected: boolean) {
    super();
    this.userData.isMetaShape = true;
    this.userData.isPickRegion = true;
    this.userData.isPickRegionSelected = isSelected;
    if (shape.metaData) {
      this.userData.metaData = shape.metaData;
    }

    const color = isSelected ? COLOR_SELECTED : COLOR_UNSELECTED;
    const opacity = isSelected ? OPACITY_SELECTED : OPACITY_UNSELECTED;

    for (const meshData of shape.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(meshData.normals), 3));
      const IndexArray = meshData.vertices.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geometry.setIndex(new BufferAttribute(new IndexArray(meshData.indices), 1));
      geometry.computeBoundingBox();

      const material = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });

      const mesh = new Mesh(geometry, material);
      this.add(mesh);
    }
  }
}
