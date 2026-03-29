import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CircleGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { SceneObjectPart } from '../../types';

const COLOR = '#2297ff';
const LINE_WIDTH = 2;
const VERTEX_RADIUS = 2;
const VERTEX_SEGMENTS = 16;
const VERTEX_SCALE_FACTOR = 0.003;
const VERTEX_MAX_SCALE = 1.5;
const EPSILON_SQ = 1e-8;

function computeViewScale(camera: Camera, position: Vector3, factor: number): number {
  if (camera instanceof OrthographicCamera) {
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    return viewHeight * factor;
  } else if (camera instanceof PerspectiveCamera) {
    const dist = camera.position.distanceTo(position);
    const vFov = camera.fov * Math.PI / 180;
    const viewHeight = 2 * dist * Math.tan(vFov / 2);
    return viewHeight * factor;
  }
  return 1;
}

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

      this.add(new LineSegments(geometry, material));

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

      dot.onBeforeRender = (_renderer, _scene, cam) => {
        dotGroup.scale.setScalar(Math.min(computeViewScale(cam, pos, VERTEX_SCALE_FACTOR), VERTEX_MAX_SCALE));
        dotGroup.updateMatrixWorld(true);
      };

      this.add(dotGroup);
    }
  }
}
