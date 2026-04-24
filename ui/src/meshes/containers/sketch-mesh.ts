import {
  Camera,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';
import { SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { createMetaEdgeMesh } from './shape-group';

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

const SKETCH_EDGE_COLOR = '#2297ff';
const VERTEX_RADIUS = 2;
const VERTEX_SEGMENTS = 16;
const VERTEX_SCALE_FACTOR = 0.003;
const VERTEX_MAX_SCALE = 1.5;
const CURSOR_COLOR = 0xf3724f;
const CURSOR_SEGMENTS = 64;
const CURSOR_RADIUS = 3;
const TANGENT_ARROW_COLOR = 0xf3724f;
const TANGENT_ARROW_OPACITY = 0.35;
const TANGENT_SHAFT_RADIUS = 0.6;
const TANGENT_SHAFT_LENGTH = 18;
const TANGENT_HEAD_LENGTH = 5;
const TANGENT_HEAD_WIDTH = 2.5;

/**
 * Renders a sketch: all child edges in blue, plus an optional cursor circle
 * at the current drawing position.
 */
export class SketchMesh extends Group {
  constructor(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[], activeSketchId: string | null, camera: Camera) {
    super();
    this.userData.isSketchRoot = true;
    this.buildEdges(sceneObject, allObjects);
    this.buildVertices(sceneObject, allObjects, camera);
    if (activeSketchId && sceneObject.id === activeSketchId) {
      this.buildCursor(sceneObject, camera);
      this.buildTangentArrow(sceneObject, camera);
    }
  }

  private buildEdges(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    for (const obj of allObjects) {
      if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
        continue;
      }

      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          if (shape.shapeType === 'wire' || shape.shapeType === 'edge') {
            const metaMesh = createMetaEdgeMesh(shape);
            if (shape.shapeId) {
              metaMesh.userData.shapeId = shape.shapeId;
            }
            this.add(metaMesh);
          }
          continue;
        }
        const edgeMesh = new EdgeMesh(shape, { color: SKETCH_EDGE_COLOR, lineWidth: 2 });
        if (shape.shapeId) {
          edgeMesh.userData.shapeId = shape.shapeId;
        }
        this.add(edgeMesh);
      }
    }
  }

  private buildVertices(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[], camera: Camera): void {
    const normal = sceneObject.object?.plane?.normal;
    const endpoints: Vector3[] = [];

    for (const obj of allObjects) {
      if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
        continue;
      }

      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          continue;
        }

        for (const meshData of shape.meshes) {
          if (!meshData.indices.length) {
            continue;
          }

          // Count how many times each vertex index appears in the line-segment pairs.
          // Vertices that appear exactly once are topological endpoints.
          const count = new Map<number, number>();
          for (const idx of meshData.indices) {
            count.set(idx, (count.get(idx) || 0) + 1);
          }

          for (const [idx, c] of count) {
            if (c === 1) {
              endpoints.push(new Vector3(
                meshData.vertices[idx * 3],
                meshData.vertices[idx * 3 + 1],
                meshData.vertices[idx * 3 + 2],
              ));
            }
          }
        }
      }
    }

    // Deduplicate coincident points
    const EPSILON_SQ = 1e-12;
    const unique: Vector3[] = [];
    for (const p of endpoints) {
      if (!unique.some(u => u.distanceToSquared(p) < EPSILON_SQ)) {
        unique.push(p);
      }
    }

    const geometry = new CircleGeometry(VERTEX_RADIUS, VERTEX_SEGMENTS);
    const material = new MeshBasicMaterial({
      color: SKETCH_EDGE_COLOR,
      side: DoubleSide,
      depthTest: false,
    });

    for (const pos of unique) {
      const dot = new Mesh(geometry, material);
      dot.renderOrder = 2;

      const dotGroup = new Group();
      dotGroup.renderOrder = 2;
      dotGroup.userData.isVertexDot = true;
      dotGroup.add(dot);
      dotGroup.position.copy(pos);

      if (normal) {
        dotGroup.lookAt(new Vector3(
          pos.x + normal.x,
          pos.y + normal.y,
          pos.z + normal.z,
        ));
      }

      dotGroup.scale.setScalar(Math.min(computeViewScale(camera, pos, VERTEX_SCALE_FACTOR), VERTEX_MAX_SCALE));

      dot.onBeforeRender = (_renderer, _scene, cam) => {
        dotGroup.scale.setScalar(Math.min(computeViewScale(cam, pos, VERTEX_SCALE_FACTOR), VERTEX_MAX_SCALE));
        dotGroup.updateMatrixWorld(true);
      };

      this.add(dotGroup);
    }
  }

  private buildCursor(sceneObject: SceneObjectRender, camera: Camera): void {
    const currentPosition = sceneObject.object?.currentPosition;
    if (!currentPosition) {
      return;
    }

    const geometry = new CircleGeometry(CURSOR_RADIUS, CURSOR_SEGMENTS);
    const material = new MeshBasicMaterial({ color: CURSOR_COLOR, side: DoubleSide, depthTest: false });
    material.transparent = true;
    material.opacity = 0.8;

    const dot = new Mesh(
      geometry,
      material
    );
    dot.renderOrder = 1;

    const cursorGroup = new Group();
    cursorGroup.renderOrder = 1;
    cursorGroup.add(dot);
    cursorGroup.position.set(currentPosition.x, currentPosition.y, currentPosition.z);

    // Orient the cursor to face the sketch plane normal
    const normal = sceneObject.object?.plane?.normal;
    if (normal) {
      const target = new Vector3(
        currentPosition.x + normal.x,
        currentPosition.y + normal.y,
        currentPosition.z + normal.z,
      );
      cursorGroup.lookAt(target);
    }

    // Set initial scale so the cursor is correctly sized on the first frame
    cursorGroup.scale.setScalar(computeViewScale(camera, cursorGroup.position, 0.003));

    // Keep consistent screen size regardless of zoom level
    dot.onBeforeRender = (_renderer, _scene, cam) => {
      cursorGroup.scale.setScalar(computeViewScale(cam, cursorGroup.position, 0.003));
      cursorGroup.updateMatrixWorld(true);
    };

    this.add(cursorGroup);
  }

  private buildTangentArrow(sceneObject: SceneObjectRender, camera: Camera): void {
    const currentPosition = sceneObject.object?.currentPosition;
    const currentTangent = sceneObject.object?.currentTangent;
    const planeOrigin = sceneObject.object?.plane?.origin;
    if (!currentPosition || !currentTangent || !planeOrigin) {
      return;
    }

    // currentTangent is localToWorld(tangent_dir), so the world direction is currentTangent - planeOrigin
    const dir = new Vector3(
      currentTangent.x - planeOrigin.x,
      currentTangent.y - planeOrigin.y,
      currentTangent.z - planeOrigin.z,
    ).normalize();

    const material = new MeshBasicMaterial({
      color: TANGENT_ARROW_COLOR,
      transparent: true,
      opacity: TANGENT_ARROW_OPACITY,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    const shaftGeometry = new CylinderGeometry(TANGENT_SHAFT_RADIUS, TANGENT_SHAFT_RADIUS, TANGENT_SHAFT_LENGTH, 16);
    shaftGeometry.translate(0, TANGENT_SHAFT_LENGTH / 2, 0);
    const shaft = new Mesh(shaftGeometry, material);

    const headGeometry = new ConeGeometry(TANGENT_HEAD_WIDTH, TANGENT_HEAD_LENGTH, 16);
    headGeometry.translate(0, TANGENT_SHAFT_LENGTH + TANGENT_HEAD_LENGTH / 2, 0);
    const head = new Mesh(headGeometry, material);

    const arrowGroup = new Group();
    arrowGroup.renderOrder = 1;
    arrowGroup.add(shaft);
    arrowGroup.add(head);

    // Rotate from default Y-up to the tangent direction
    const up = new Vector3(0, 1, 0);
    const quaternion = new Quaternion().setFromUnitVectors(up, dir);
    arrowGroup.quaternion.copy(quaternion);
    arrowGroup.position.set(currentPosition.x, currentPosition.y, currentPosition.z);

    // Set initial scale so the arrow is correctly sized on the first frame
    arrowGroup.scale.setScalar(computeViewScale(camera, arrowGroup.position, 0.003));

    // Keep consistent screen size regardless of zoom level
    shaft.onBeforeRender = (_renderer, _scene, cam) => {
      arrowGroup.scale.setScalar(computeViewScale(cam, arrowGroup.position, 0.003));
      arrowGroup.updateMatrixWorld(true);
    };

    this.add(arrowGroup);
  }
}
