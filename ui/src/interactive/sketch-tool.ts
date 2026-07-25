import { Group } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender, Vec3Data } from '../types';
import { SnapController } from '../snapping/snap-controller';
import { SnapManager } from '../snapping/snap-manager';
import { worldToSketch2D, pixelToSketchThreshold, dist2D } from './sketch-plane-utils';

export type ToolId = 'line' | 'polyline' | 'circle' | 'polygon' | 'arc3' | 'arc2' | 'rect' | 'rounded-rect' | 'slot' | 'trim' | 'fillet' | 'offset' | 'fuse' | 'subtract' | 'common' | 'bezier' | 'text' | 'project';

export type ToolConfig = {
  id: ToolId;
  label: string;
  icon: string;
};

export type NewVariable = { name: string; initializer: string };

export type InsertGeometryFn = (
  statement: string,
  newVariable?: NewVariable | NewVariable[],
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

  handleEscape?(): boolean;

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

  static negateExpression(expression: string): string {
    const isIdentifier = /^[a-zA-Z_$][\w$]*$/.test(expression);
    return isIdentifier ? `-${expression}` : `-(${expression})`;
  }

  // Best-effort numeric value of a committed variable dimension, for preview
  // purposes only: a newly declared variable carries its initializer, an
  // existing one may have a literal initializer. Null when the value can't
  // be resolved statically (e.g. the initializer is itself an expression).
  static resolveCommittedValue(
    result: { expression: string; newVariable?: { name: string; initializer: string } },
    variables: { name: string; initializer?: string }[],
  ): number | null {
    const initializer = result.newVariable?.initializer
      ?? variables.find((v) => v.name === result.expression)?.initializer;
    if (!initializer || !initializer.trim()) {
      return null;
    }
    const parsed = Number(initializer.trim());
    if (isNaN(parsed) || !isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  static resolveCommittedMagnitude(
    result: { expression: string; newVariable?: { name: string; initializer: string } },
    variables: { name: string; initializer?: string }[],
  ): number | null {
    const value = SketchTool.resolveCommittedValue(result, variables);
    return value === null ? null : Math.abs(value);
  }

  // Re-applies the drag direction to a committed dimension: numeric input has
  // the sign baked into the value, a variable/expression is negated at the
  // use site so the variable itself stays a positive magnitude.
  static applySignedDimension(expression: string, sign: number): string {
    const num = parseFloat(expression);
    if (!isNaN(num) && String(num) === expression) {
      return String(Math.round(sign * num * 100) / 100);
    }
    if (sign < 0) {
      return SketchTool.negateExpression(expression);
    }
    return expression;
  }
}
