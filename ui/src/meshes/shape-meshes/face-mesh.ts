import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshPhongMaterial,
} from 'three';
import { FaceMeshOptions, SceneObjectPart } from '../../types';
import type { Appearance } from '../../../../lib/common/appearances';
import { themeColors } from '../../scene/theme-colors';
import { createAppearanceMaterial, type GrainAxis } from '../appearance/appearance-material';
import { faceDepthOffset } from './face-depth-offset';
import { MM_PER_UNIT } from '../../units/units';
import { sceneUnit } from '../../units/scene-unit';

const DEFAULTS: Required<FaceMeshOptions> = {
  color: '',
  opacity: 1,
  depthTest: true,
  slopeOffset: false,
};

export class FaceMesh extends Group {
  /**
   * `appearance` is the enclosing part's preset (a solid's faces only): an
   * unpainted face group — no `meshData.color`, no overlay tint — is shaded
   * with it; a `color()`-painted group keeps its flat Phong colour, the
   * paint being the override.
   */
  constructor(shape: SceneObjectPart, options: FaceMeshOptions = {}, appearance?: Appearance, grainAxis?: GrainAxis) {
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
      const material = appearance && !isOverlay && meshData.color === undefined
        ? createAppearanceMaterial(appearance, {
          unitsPerMm: 1 / MM_PER_UNIT[sceneUnit.current],
          grainAxis,
          opacity: opts.opacity,
          depthTest: opts.depthTest,
          slopeOffset: opts.slopeOffset,
        })
        : new MeshPhongMaterial({
        color: faceColor,
        transparent: isOverlay || opts.opacity < 1,
        opacity: opts.opacity,
        depthWrite: !isOverlay,
        depthTest: opts.depthTest,
        polygonOffset: true,
        // Overlays slot between edge lines (offset 0) and base faces: in
        // front of the face they tint, but behind the edges' depth, so edge
        // lines stay visible when adjacent faces are both overlaid.
        ...faceDepthOffset(isOverlay, opts.slopeOffset),
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
