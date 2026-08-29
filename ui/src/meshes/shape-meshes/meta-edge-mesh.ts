import { BufferAttribute, BufferGeometry, Group } from 'three';
import { SceneObjectPart } from '../../types';
import { themeColors } from '../../scene/theme-colors';
import { createDashDotLine } from '../dash-dot-line';

/**
 * Renders meta-shape / guide edges as dash-dot light-gray lines.
 *
 * The backend emits edge data as vertex pairs for LineSegments. To get
 * proper dashing we rebuild the data as a continuous polyline so that
 * `computeLineDistances()` accumulates across the whole curve.
 */
export class MetaEdgeMesh extends Group {
  constructor(shape: SceneObjectPart) {
    super();
    this.userData.isMetaShape = true;

    for (const meshData of shape.meshes) {
      const srcVerts = meshData.vertices;
      const indices = meshData.indices;

      // Build a continuous polyline from the segment pairs.
      // Pairs share endpoints: seg0=(A,B), seg1=(B,C), …
      // Take the first vertex of each pair, plus the last vertex of the final pair.
      const positions: number[] = [];
      for (let i = 0; i < indices.length; i += 2) {
        const idx = indices[i] * 3;
        positions.push(srcVerts[idx], srcVerts[idx + 1], srcVerts[idx + 2]);
      }
      // Append the end vertex of the last pair
      if (indices.length >= 2) {
        const lastIdx = indices[indices.length - 1] * 3;
        positions.push(srcVerts[lastIdx], srcVerts[lastIdx + 1], srcVerts[lastIdx + 2]);
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));

      const line = createDashDotLine(geometry, themeColors.metaEdgeColor, {
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 1,
      });
      // Live drags rewrite guide-entity polylines in place (SketchMesh
      // updateSolvedGeometry) — mark the line so the rewrite can find it.
      line.userData.isDashDotEdgeLine = true;
      this.add(line);
    }
  }
}
