import { Group, Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../types';
import {
  addDot,
  addDashedLine,
} from './tools/tool-preview-utils';

const META_VERTEX_COLOR = '#8899aa';
const META_VERTEX_RADIUS = 1.5;
const META_VERTEX_PX_RADIUS = 4.5;
const META_VERTEX_OPACITY = 0.5;
const META_VERTEX_RENDER_ORDER = 2;

export class BezierHandlesOverlay {
  private ctx: SceneContext;
  private group: Group;
  private active = false;

  constructor(ctx: SceneContext) {
    this.ctx = ctx;
    this.group = new Group();
    this.group.userData.isMetaShape = true;
    this.group.renderOrder = 3;
  }

  activate(): void {
    if (this.active) {
      return;
    }
    this.ctx.scene.add(this.group);
    this.active = true;
  }

  deactivate(): void {
    if (!this.active) {
      return;
    }
    this.ctx.scene.remove(this.group);
    this.disposeGroup();
    this.active = false;
    this.ctx.requestRender();
  }

  update(sceneObjects: SceneObjectRender[], sketchId: string, plane: PlaneData): void {
    if (!this.active) {
      return;
    }
    this.disposeGroup();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(plane.normal.x, plane.normal.y, plane.normal.z);

    for (const obj of sceneObjects) {
      if (obj.parentId !== sketchId || (obj as any).type !== 'bezier') {
        continue;
      }
      const start = (obj as any).object?.startPoint as [number, number] | undefined;
      const poles = (obj as any).object?.resolvedPoints as [number, number][] | undefined;
      const allPoints: [number, number][] = [];
      if (start) {
        allPoints.push(start);
      }
      if (poles) {
        allPoints.push(...poles);
      }
      for (let i = 1; i < allPoints.length; i++) {
        addDashedLine(this.group, allPoints[i - 1], allPoints[i], plane, META_VERTEX_RENDER_ORDER);
      }
      for (const pt of allPoints) {
        addDot(
          this.group,
          pt,
          META_VERTEX_COLOR,
          camera,
          planeNormal,
          plane,
          META_VERTEX_OPACITY,
          META_VERTEX_RENDER_ORDER,
          META_VERTEX_RADIUS,
          META_VERTEX_PX_RADIUS,
        );
      }
    }

    this.ctx.requestRender();
  }

  private disposeGroup(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      const anyChild = child as any;
      if (anyChild.geometry) {
        anyChild.geometry.dispose();
      }
      if (anyChild.material) {
        anyChild.material.dispose();
      }
      const inner = (child as Group).children?.[0] as any;
      if (inner?.geometry) {
        inner.geometry.dispose();
      }
      if (inner?.material) {
        inner.material.dispose();
      }
    }
  }
}
