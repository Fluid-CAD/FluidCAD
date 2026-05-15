import {
  Camera,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { createMetaEdgeMesh } from './shape-group';
import { isInteractiveSketchType } from '../../interactive/sketch-edge-utils';
import { buildConstraintIcons } from './constraint-icon';
import { applyConstantPixelSize } from '../screen-scale';

const SKETCH_EDGE_COLOR = '#2297ff';
const NON_INTERACTIVE_EDGE_COLOR = '#6a5acd';
const VERTEX_RADIUS = 2;
const VERTEX_SEGMENTS = 16;
const VERTEX_PX_RADIUS = 6;
const META_VERTEX_COLOR = '#8899aa';
const META_VERTEX_RADIUS = 1.5;
const META_VERTEX_PX_RADIUS = 4.5;
const CURSOR_COLOR = 0xf3724f;
const CURSOR_SEGMENTS = 64;
const CURSOR_RADIUS = 3;
const CURSOR_PX_RADIUS = 9;
const TANGENT_ARROW_COLOR = 0xf3724f;
const TANGENT_ARROW_OPACITY = 0.35;
const TANGENT_SHAFT_RADIUS = 0.6;
const TANGENT_SHAFT_LENGTH = 18;
const TANGENT_HEAD_LENGTH = 5;
const TANGENT_HEAD_WIDTH = 2.5;
const TANGENT_TOTAL_LENGTH = TANGENT_SHAFT_LENGTH + TANGENT_HEAD_LENGTH;
const TANGENT_PX_LENGTH = 54;

/**
 * Renders a sketch: all child edges in blue, plus an optional cursor circle
 * at the current drawing position.
 */
export class SketchMesh extends Group {
  constructor(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[], activeSketchId: string | null, _camera: Camera) {
    super();
    this.userData.isSketchRoot = true;
    this.buildEdges(sceneObject, allObjects);
    this.buildVertices(sceneObject, allObjects);
    this.addConstraintIcons(sceneObject, allObjects);
    if (activeSketchId && sceneObject.id === activeSketchId) {
      this.buildCursor(sceneObject);
      this.buildTangentArrow(sceneObject);
    }
  }

  private buildEdges(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    for (const obj of allObjects) {
      if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
        continue;
      }

      const interactive = isInteractiveSketchType(obj.uniqueType);
      const edgeColor = interactive ? SKETCH_EDGE_COLOR : NON_INTERACTIVE_EDGE_COLOR;

      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          if (shape.shapeType === 'wire' || shape.shapeType === 'edge') {
            const metaMesh = createMetaEdgeMesh(shape);
            metaMesh.traverse(child => { child.renderOrder = 1; });
            if (shape.shapeId) {
              metaMesh.userData.shapeId = shape.shapeId;
            }
            this.add(metaMesh);
          }
          continue;
        }
        const edgeMesh = new EdgeMesh(shape, { color: edgeColor, lineWidth: 2, depthWrite: false, transparent: true });
        edgeMesh.traverse(child => { child.renderOrder = 1; });
        if (shape.shapeId) {
          edgeMesh.userData.shapeId = shape.shapeId;
        }
        this.add(edgeMesh);
      }
    }
  }

  private buildVertices(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    const normal = sceneObject.object?.plane?.normal;
    const endpoints: Vector3[] = [];
    const nonInteractiveEndpoints: Vector3[] = [];
    const metaVertices: Vector3[] = [];

    for (const obj of allObjects) {
      if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
        continue;
      }

      const interactive = isInteractiveSketchType(obj.uniqueType);

      for (const shape of obj.sceneShapes) {
        if (shape.isGuide) {
          continue;
        }

        if (shape.isMetaShape) {
          for (const meshData of shape.meshes) {
            if (meshData.vertices.length === 3 && meshData.indices.length === 0) {
              metaVertices.push(new Vector3(
                meshData.vertices[0],
                meshData.vertices[1],
                meshData.vertices[2],
              ));
            }
          }
          continue;
        }

        const target = interactive ? endpoints : nonInteractiveEndpoints;
        for (const meshData of shape.meshes) {
          if (!meshData.indices.length) {
            continue;
          }

          const count = new Map<number, number>();
          for (const idx of meshData.indices) {
            count.set(idx, (count.get(idx) || 0) + 1);
          }

          for (const [idx, c] of count) {
            if (c === 1) {
              target.push(new Vector3(
                meshData.vertices[idx * 3],
                meshData.vertices[idx * 3 + 1],
                meshData.vertices[idx * 3 + 2],
              ));
            }
          }
        }
      }
    }

    const EPSILON_SQ = 1e-12;

    const uniqueEndpoints = this.dedup(endpoints, EPSILON_SQ);
    const uniqueNonInteractive = this.dedup(nonInteractiveEndpoints, EPSILON_SQ);
    const uniqueMeta = this.dedup(metaVertices, EPSILON_SQ);

    this.addVertexDots(uniqueEndpoints, normal, VERTEX_RADIUS, VERTEX_PX_RADIUS, SKETCH_EDGE_COLOR, 1);
    this.addVertexDots(uniqueNonInteractive, normal, VERTEX_RADIUS, VERTEX_PX_RADIUS, NON_INTERACTIVE_EDGE_COLOR, 1);
    this.addVertexDots(uniqueMeta, normal, META_VERTEX_RADIUS, META_VERTEX_PX_RADIUS, META_VERTEX_COLOR, 0.5);
  }

  private addConstraintIcons(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    for (const icon of buildConstraintIcons(sceneObject, allObjects)) {
      this.add(icon);
    }
  }

  private dedup(points: Vector3[], epsilonSq: number): Vector3[] {
    const unique: Vector3[] = [];
    for (const p of points) {
      if (!unique.some(u => u.distanceToSquared(p) < epsilonSq)) {
        unique.push(p);
      }
    }
    return unique;
  }

  private addVertexDots(
    positions: Vector3[],
    normal: { x: number; y: number; z: number } | undefined,
    radius: number,
    targetPixels: number,
    color: string | number,
    opacity: number,
  ): void {
    const geometry = new CircleGeometry(radius, VERTEX_SEGMENTS);
    const material = new MeshBasicMaterial({
      color,
      side: DoubleSide,
      depthTest: false,
      transparent: true,
      opacity,
    });

    for (const pos of positions) {
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

      applyConstantPixelSize(dot, dotGroup, pos, targetPixels, radius);

      this.add(dotGroup);
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

    const normal = sceneObject.object?.plane?.normal;
    if (normal) {
      const target = new Vector3(
        currentPosition.x + normal.x,
        currentPosition.y + normal.y,
        currentPosition.z + normal.z,
      );
      cursorGroup.lookAt(target);
    }

    applyConstantPixelSize(dot, cursorGroup, cursorGroup.position, CURSOR_PX_RADIUS, CURSOR_RADIUS);

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

    applyConstantPixelSize(shaft, arrowGroup, arrowGroup.position, TANGENT_PX_LENGTH, TANGENT_TOTAL_LENGTH);

    this.add(arrowGroup);
  }
}
