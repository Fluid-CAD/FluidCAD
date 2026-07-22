import { DoubleSide, Group } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SceneObjectPart } from '../../types';
import { EdgeMesh } from './edge-mesh';
import { LineResolutionRegistry } from './line-resolution';

const COLOR = '#2297ff';
const LINE_WIDTH = 2;

/**
 * Renders trim-helper meta edges as solid blue lines matching regular sketch
 * edge styling.
 */
export class TrimMetaEdgeMesh extends Group {
  constructor(shape: SceneObjectPart) {
    super();
    this.userData.isMetaShape = true;

    for (const meshData of shape.meshes) {
      const positions = EdgeMesh.expandIndexedPositions(meshData.vertices, meshData.indices);

      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);

      const material = new LineMaterial({
        color: COLOR,
        linewidth: LINE_WIDTH,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: DoubleSide,
        depthWrite: true,
        depthTest: true,
      });
      LineResolutionRegistry.register(material);

      const segments = new LineSegments2(geometry, material);
      // The viewer's highlight walk tints children flagged as edge lines
      // (LineSegments2 carries no isLine of its own).
      segments.userData.isEdgeLine = true;
      this.add(segments);
    }
  }
}
