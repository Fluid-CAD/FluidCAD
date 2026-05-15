import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
  dist2D,
  pixelToSketchThreshold,
} from '../sketch-plane-utils';
import { ICON_POLYGON } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedCircle,
  addDashedPolygon,
} from './tool-preview-utils';

type ExpressionPhase = 'diameter' | 'sides';

const MIN_SIDES = 3;
const MAX_SIDES = 24;
const DEFAULT_SIDES = 6;
const PX_PER_SIDE = 25;

export class PolygonTool extends SketchTool {
  readonly id = 'polygon' as const;
  readonly label = 'Polygon';
  readonly icon = ICON_POLYGON;

  private centerPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'diameter';
  private diameterExpression: CommitResult | null = null;
  private lockedDiameter: number | null = null;
  private currentSides = DEFAULT_SIDES;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    fetchVariables: FetchVariablesFn,
  ) {
    super(ctx, plane, snapController, insertGeometry);
    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.resetState();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane);
    this.updateSnapManager(snapManager);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  private resetState(): void {
    this.centerPoint = null;
    this.mousePoint = null;
    this.expressionPhase = 'diameter';
    this.diameterExpression = null;
    this.lockedDiameter = null;
    this.currentSides = DEFAULT_SIDES;
    this.expressionInput.hide();
  }

  private sidesFromDistance(dist: number): number {
    if (this.lockedDiameter !== null && this.lockedDiameter > 0) {
      const ratio = dist / (this.lockedDiameter / 2);
      return Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(ratio * DEFAULT_SIDES)));
    }
    const sketchUnitsPerSide = pixelToSketchThreshold(this.ctx, PX_PER_SIDE);
    if (sketchUnitsPerSide <= 0) {
      return DEFAULT_SIDES;
    }
    return Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(dist / sketchUnitsPerSide)));
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return;
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    const point = roundPoint(result.point2d);

    if (!this.centerPoint) {
      this.centerPoint = point;
      this.rebuildPreview();
      return;
    }

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
      return;
    }

    if (this.expressionPhase === 'diameter') {
      const diameter = Math.round(dist2D(this.centerPoint, point) * 2 * 100) / 100;
      if (diameter <= 0) {
        return;
      }
      this.onDiameterCommit({ expression: String(diameter) });
    } else {
      this.onSidesCommit({ expression: String(this.currentSides) });
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.rebuildPreview();
      return;
    }

    const result = this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;

    if (this.centerPoint && this.expressionPhase === 'sides') {
      const dist = dist2D(this.centerPoint, this.mousePoint);
      this.currentSides = this.sidesFromDistance(dist);
    }

    this.rebuildPreview();
    this.updateDimensionInput();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.centerPoint) {
        this.resetState();
        this.rebuildPreview();
      }
    }
  }

  private updateDimensionInput(): void {
    if (!this.centerPoint || !this.mousePoint) {
      return;
    }

    if (this.expressionPhase === 'diameter') {
      const diameter = Math.round(dist2D(this.centerPoint, this.mousePoint) * 2 * 100) / 100;
      if (diameter <= 0) {
        return;
      }

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: '⌀',
          value: String(diameter),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onDiameterCommit(result),
        });
      } else {
        this.expressionInput.updateValue(diameter);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    } else {
      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'N',
          value: String(this.currentSides),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onSidesCommit(result),
        });
      } else {
        this.expressionInput.updateValue(this.currentSides);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    }
  }

  private onDiameterCommit(result: CommitResult): void {
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.diameterExpression = result;
    this.lockedDiameter = isNumeric ? num : null;
    this.expressionPhase = 'sides';

    queueMicrotask(() => {
      if (this.mousePoint && this.centerPoint) {
        const dist = dist2D(this.centerPoint, this.mousePoint);
        this.currentSides = this.sidesFromDistance(dist);
      }

      this.expressionInput.show({
        label: 'N',
        value: String(this.currentSides),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        onCommit: (r) => this.onSidesCommit(r),
      });
      this.rebuildPreview();
    });
  }

  private onSidesCommit(result: CommitResult): void {
    if (!this.centerPoint || !this.diameterExpression) {
      return;
    }

    this.commitPolygon(this.centerPoint, this.diameterExpression, result);
    this.resetState();
    this.rebuildPreview();
  }

  private commitPolygon(
    center: [number, number],
    diameterResult: CommitResult,
    sidesResult: CommitResult,
  ): void {
    const atCurrent = this.isAtCurrentPosition(center);
    const statement = atCurrent
      ? `polygon(${sidesResult.expression}, ${diameterResult.expression})`
      : `polygon(${this.formatPoint(center)}, ${sidesResult.expression}, ${diameterResult.expression})`;

    const newVariable = sidesResult.newVariable ?? diameterResult.newVariable;
    this.insertGeometry(statement, newVariable);
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.centerPoint) {
      addDot(this.previewGroup, this.centerPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.mousePoint) {
        if (this.expressionPhase === 'diameter') {
          const radius = dist2D(this.centerPoint, this.mousePoint);
          if (radius > 0) {
            addDashedCircle(this.previewGroup, this.centerPoint, radius, this.plane);
          }
        } else {
          const inscribedRadius = this.lockedDiameter !== null
            ? this.lockedDiameter / 2
            : dist2D(this.centerPoint, this.mousePoint);

          if (inscribedRadius > 0 && this.currentSides >= MIN_SIDES) {
            const circumscribedRadius = inscribedRadius / Math.cos(Math.PI / this.currentSides);
            addDashedPolygon(this.previewGroup, this.centerPoint, circumscribedRadius, this.currentSides, this.plane);
          }
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
