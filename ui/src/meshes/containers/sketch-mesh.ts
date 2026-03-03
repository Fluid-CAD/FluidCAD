import {
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
import { MetaEdgeMesh } from '../shape-meshes/meta-edge-mesh';

const SKETCH_EDGE_COLOR = '#2297ff';
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
  constructor(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[], isSketchMode: boolean) {
    super();
    this.buildEdges(sceneObject, allObjects);
    if (isSketchMode && sceneObject.visible) {
      this.buildCursor(sceneObject);
      this.buildTangentArrow(sceneObject);
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
            this.add(new MetaEdgeMesh(shape));
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

  private buildCursor(sceneObject: SceneObjectRender): void {
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

    // Keep consistent screen size regardless of zoom level
    dot.onBeforeRender = (_renderer, _scene, camera) => {
      if (camera instanceof OrthographicCamera) {
        const viewHeight = (camera.top - camera.bottom) / camera.zoom;
        cursorGroup.scale.setScalar(viewHeight * 0.003);
      } else if (camera instanceof PerspectiveCamera) {
        const dist = camera.position.distanceTo(cursorGroup.position);
        const vFov = camera.fov * Math.PI / 180;
        const viewHeight = 2 * dist * Math.tan(vFov / 2);
        cursorGroup.scale.setScalar(viewHeight * 0.003);
      }
    };

    this.add(cursorGroup);
  }

  private buildTangentArrow(sceneObject: SceneObjectRender): void {
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
      depthTest: false,
    });

    const shaftGeometry = new CylinderGeometry(TANGENT_SHAFT_RADIUS, TANGENT_SHAFT_RADIUS, TANGENT_SHAFT_LENGTH, 8);
    shaftGeometry.translate(0, TANGENT_SHAFT_LENGTH / 2, 0);
    const shaft = new Mesh(shaftGeometry, material);

    const headGeometry = new ConeGeometry(TANGENT_HEAD_WIDTH, TANGENT_HEAD_LENGTH, 8);
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

    // Keep consistent screen size regardless of zoom level
    shaft.onBeforeRender = (_renderer, _scene, camera) => {
      if (camera instanceof OrthographicCamera) {
        const viewHeight = (camera.top - camera.bottom) / camera.zoom;
        arrowGroup.scale.setScalar(viewHeight * 0.003);
      } else if (camera instanceof PerspectiveCamera) {
        const dist = camera.position.distanceTo(arrowGroup.position);
        const vFov = camera.fov * Math.PI / 180;
        const viewHeight = 2 * dist * Math.tan(vFov / 2);
        arrowGroup.scale.setScalar(viewHeight * 0.003);
      }
      arrowGroup.updateMatrixWorld(true);
    };

    this.add(arrowGroup);
  }
}
