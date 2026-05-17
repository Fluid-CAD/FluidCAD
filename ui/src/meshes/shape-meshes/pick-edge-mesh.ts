import {
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SceneObjectPart } from '../../types';
import { applyConstantPixelSize } from '../screen-scale';
import { EdgeMesh } from './edge-mesh';
import { LineResolutionRegistry } from './line-resolution';

const COLOR = '#2297ff';
const LINE_WIDTH = 2;
const VERTEX_RADIUS = 2;
const VERTEX_SEGMENTS = 16;
const VERTEX_PX_RADIUS = 6;
const EPSILON_SQ = 1e-8;

/**
 * Renders pick-edge meta edges as solid blue lines with vertex dots
 * at endpoints, matching sketch edge styling.
 */
export class PickEdgeMesh extends Group {
  constructor(shape: SceneObjectPart) {
    super();
    this.userData.isMetaShape = true;

    const dotGeometry = new CircleGeometry(VERTEX_RADIUS, VERTEX_SEGMENTS);
    const dotMaterial = new MeshBasicMaterial({
      color: COLOR,
      side: DoubleSide,
      depthTest: true,
    });

    const allEndpoints: Vector3[] = [];

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

      this.add(new LineSegments2(geometry, material));

      // Collect unique endpoints from edge line segments
      const verts = meshData.vertices;
      const indices = meshData.indices;
      const count = new Map<number, number>();
      for (const idx of indices) {
        count.set(idx, (count.get(idx) || 0) + 1);
      }
      for (const [idx, c] of count) {
        if (c === 1) {
          const v = new Vector3(verts[idx * 3], verts[idx * 3 + 1], verts[idx * 3 + 2]);
          if (!allEndpoints.some(u => u.distanceToSquared(v) < EPSILON_SQ)) {
            allEndpoints.push(v);
          }
        }
      }
    }

    // Add vertex dots at unique endpoints
    for (const pos of allEndpoints) {
      const dot = new Mesh(dotGeometry, dotMaterial);
      dot.renderOrder = 2;

      const dotGroup = new Group();
      dotGroup.renderOrder = 2;
      dotGroup.userData.isVertexDot = true;
      dotGroup.add(dot);
      dotGroup.position.copy(pos);

      applyConstantPixelSize(dot, dotGroup, pos, VERTEX_PX_RADIUS, VERTEX_RADIUS);

      this.add(dotGroup);
    }
  }
}
