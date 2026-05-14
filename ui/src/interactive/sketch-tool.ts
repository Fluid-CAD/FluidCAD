import { Group } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender, Vec3Data } from '../types';
import { SnapController } from '../snapping/snap-controller';
import { SnapManager } from '../snapping/snap-manager';
import { worldToSketch2D, pixelToSketchThreshold, dist2D } from './sketch-plane-utils';

export type ToolId = 'line' | 'circle' | 'arc3' | 'arc2' | 'rect' | 'rounded-rect' | 'slot' | 'trim' | 'bezier' | 'tarc';

export type ToolConfig = {
  id: ToolId;
  label: string;
  icon: string;
};

export type InsertGeometryFn = (
  statement: string,
  newVariable?: { name: string; initializer: string },
) => void;
export type FetchVariablesFn = () => Promise<{ name: string; initializer?: string }[]>;

export abstract class SketchTool {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  abstract readonly icon: string;

  protected ctx: SceneContext;
  protected plane: PlaneData;
  protected snapController: SnapController;
  protected previewGroup: Group;
  protected insertGeometry: InsertGeometryFn;
  protected canvas: HTMLCanvasElement;
  protected currentPosition: [number, number] | null = null;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
  ) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.insertGeometry = insertGeometry;
    this.canvas = ctx.renderer.domElement;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 3;
  }

  abstract activate(): void;
  abstract deactivate(): void;
  abstract onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void;

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSnapManager(snapManager: SnapManager): void {
    this.snapController.updateSnapManager(snapManager);
  }

  updateCurrentPosition(worldPos: Vec3Data | null): void {
    if (worldPos) {
      this.currentPosition = worldToSketch2D(worldPos, this.plane);
    } else {
      this.currentPosition = null;
    }
  }

  protected isAtCurrentPosition(point2d: [number, number]): boolean {
    if (!this.currentPosition) {
      return false;
    }
    const threshold = pixelToSketchThreshold(this.ctx, 15);
    return dist2D(point2d, this.currentPosition) <= threshold;
  }

  protected disposePreview(): void {
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0];
      this.previewGroup.remove(child);
      const obj = child as any;
      if (obj.geometry) {
        obj.geometry.dispose();
      }
      if (obj.material) {
        obj.material.dispose();
      }
    }
  }

  protected addPreviewToScene(): void {
    this.ctx.scene.add(this.previewGroup);
  }

  protected removePreviewFromScene(): void {
    this.ctx.scene.remove(this.previewGroup);
    this.disposePreview();
    this.ctx.requestRender();
  }

  protected requestRender(): void {
    this.ctx.requestRender();
  }

  protected formatPoint(p: [number, number]): string {
    return `[${p[0]}, ${p[1]}]`;
  }
}
