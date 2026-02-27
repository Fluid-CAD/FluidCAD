import {
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { MetaEdgeMesh } from '../shape-meshes/meta-edge-mesh';

const SKETCH_EDGE_COLOR = '#2297ff';
const CURSOR_COLOR = 0xf3724f;
const CURSOR_SEGMENTS = 64;
const CURSOR_RADIUS = 3;

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
}
