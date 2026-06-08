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
  sketchToClient,
} from '../sketch-plane-utils';
import { ICON_ROUNDED_RECT } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedRect,
  addDashedRoundedRect,
} from './tool-preview-utils';

type ExpressionPhase = 'width' | 'height' | 'radius';

export class RoundedRectTool extends SketchTool {
  readonly id = 'rounded-rect' as const;
  readonly label = 'Rounded Rectangle';
  readonly icon = ICON_ROUNDED_RECT;

  private startPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private shiftHeld = false;
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'width';
  private widthExpression: CommitResult | null = null;
  private heightExpression: CommitResult | null = null;
  private lockedWidth: number | null = null;
  private lockedHeight: number | null = null;
  private widthIsNumeric = false;
  private heightIsNumeric = false;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
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
    this.boundKeyUp = this.handleKeyUp.bind(this);
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.resetState();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  private resetState(): void {
    this.startPoint = null;
    this.mousePoint = null;
    this.expressionPhase = 'width';
    this.widthExpression = null;
    this.heightExpression = null;
    this.lockedWidth = null;
    this.lockedHeight = null;
    this.widthIsNumeric = false;
    this.heightIsNumeric = false;
    this.shiftHeld = false;
    this.expressionInput.hide();
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

    if (!this.startPoint) {
      this.startPoint = point;
      this.syncModifiers(e);
      this.rebuildPreview();
      return;
    }

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    } else if (this.expressionPhase === 'width' || this.expressionPhase === 'height') {
      this.commitDimensionsFromGeometry(point);
    } else if (this.expressionPhase === 'radius') {
      const radius = this.computeRadiusFromMouse(point);
      this.commitRoundedRect(
        this.startPoint,
        this.widthExpression!,
        this.heightExpression!,
        { expression: String(radius) },
      );
      this.resetState();
      this.rebuildPreview();
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.syncModifiers(e);

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
    this.rebuildPreview();
    this.updateDimensionInput();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.startPoint) {
        this.resetState();
        this.rebuildPreview();
      }
      return;
    }
    if (e.key === 'Shift') {
      this.shiftHeld = true;
      this.rebuildPreview();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      this.shiftHeld = false;
      this.rebuildPreview();
    }
  }

  private syncModifiers(e: MouseEvent): void {
    this.shiftHeld = e.shiftKey;
  }

  private computeDimensions(endPoint: [number, number]): { width: number; height: number } {
    const start = this.startPoint!;
    if (this.shiftHeld) {
      const dx = endPoint[0] - start[0];
      const dy = endPoint[1] - start[1];
      return { width: Math.round(dx * 2 * 100) / 100, height: Math.round(dy * 2 * 100) / 100 };
    }
    return {
      width: Math.round((endPoint[0] - start[0]) * 100) / 100,
      height: Math.round((endPoint[1] - start[1]) * 100) / 100,
    };
  }

  private computePreviewCorners(endPoint: [number, number]): { c1: [number, number]; c2: [number, number] } {
    const start = this.startPoint!;

    const wLocked = this.lockedWidth !== null;
    const hLocked = this.lockedHeight !== null;

    if (wLocked && hLocked) {
      return this.getLockedPreviewCorners()!;
    }

    if (wLocked) {
      if (this.shiftHeld) {
        const hw = this.lockedWidth! / 2;
        const dy = endPoint[1] - start[1];
        return {
          c1: [start[0] - hw, start[1] - dy],
          c2: [start[0] + hw, start[1] + dy],
        };
      }
      const xSign = (endPoint[0] >= start[0]) ? 1 : -1;
      return { c1: start, c2: [start[0] + xSign * this.lockedWidth!, endPoint[1]] };
    }

    if (this.shiftHeld) {
      const dx = endPoint[0] - start[0];
      const dy = endPoint[1] - start[1];
      return {
        c1: [start[0] - dx, start[1] - dy],
        c2: [start[0] + dx, start[1] + dy],
      };
    }
    return { c1: start, c2: endPoint };
  }

  private getLockedPreviewCorners(): { c1: [number, number]; c2: [number, number] } | null {
    if (!this.startPoint || this.lockedWidth === null || this.lockedHeight === null) {
      return null;
    }
    if (this.shiftHeld) {
      const hw = this.lockedWidth / 2;
      const hh = this.lockedHeight / 2;
      return {
        c1: [this.startPoint[0] - hw, this.startPoint[1] - hh],
        c2: [this.startPoint[0] + hw, this.startPoint[1] + hh],
      };
    }
    const xSign = this.mousePoint ? ((this.mousePoint[0] >= this.startPoint[0]) ? 1 : -1) : 1;
    const ySign = this.mousePoint ? ((this.mousePoint[1] >= this.startPoint[1]) ? 1 : -1) : 1;
    return {
      c1: this.startPoint,
      c2: [this.startPoint[0] + xSign * this.lockedWidth, this.startPoint[1] + ySign * this.lockedHeight],
    };
  }

  private computeRadiusFromMouse(point: [number, number]): number {
    const corners = this.getLockedPreviewCorners();
    if (!corners) {
      return 0;
    }
    const { c1, c2 } = corners;

    const rectCorners: [number, number][] = [
      [c1[0], c1[1]],
      [c2[0], c1[1]],
      [c2[0], c2[1]],
      [c1[0], c2[1]],
    ];

    let minDist = Infinity;
    for (const rc of rectCorners) {
      const d = dist2D(point, rc);
      if (d < minDist) {
        minDist = d;
      }
    }

    const maxRadius = Math.min(Math.abs(c2[0] - c1[0]) / 2, Math.abs(c2[1] - c1[1]) / 2);
    const radius = Math.round(Math.min(minDist, maxRadius) * 100) / 100;
    return radius;
  }

  // Anchor the dimension input at the midpoint of what's being set: the
  // horizontal centre of the width edge, the vertical centre of the height
  // edge, or the centre of the locked rectangle while setting the corner
  // radius. Falls back to the cursor if the shape isn't established yet.
  private dimensionInputAnchor(): { clientX: number; clientY: number } {
    const fallback = { clientX: this.lastClientX, clientY: this.lastClientY };
    if (!this.startPoint || !this.mousePoint) {
      return fallback;
    }
    if (this.expressionPhase === 'radius') {
      const corners = this.getLockedPreviewCorners();
      if (!corners) {
        return fallback;
      }
      const { c1, c2 } = corners;
      return sketchToClient(this.ctx, this.plane, [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2]);
    }
    const { c1, c2 } = this.computePreviewCorners(this.mousePoint);
    const mid: [number, number] = this.expressionPhase === 'width'
      ? [(c1[0] + c2[0]) / 2, c1[1]]
      : [c2[0], (c1[1] + c2[1]) / 2];
    return sketchToClient(this.ctx, this.plane, mid);
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }

    const anchor = this.dimensionInputAnchor();

    if (this.expressionPhase === 'width') {
      const { width } = this.computeDimensions(this.mousePoint);
      const absW = Math.round(Math.abs(width) * 100) / 100;
      if (absW <= 0) {
        return;
      }

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'W',
          value: String(absW),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onWidthCommit(result),
        });
      } else {
        this.expressionInput.updateValue(absW);
        this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
      }
    } else if (this.expressionPhase === 'height') {
      const { height } = this.computeDimensions(this.mousePoint);
      const absH = Math.round(Math.abs(height) * 100) / 100;
      const hSign = height >= 0 ? 1 : -1;

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'H',
          value: String(absH),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onHeightCommit(result, hSign),
        });
      } else {
        this.expressionInput.updateValue(absH);
        this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
      }
    } else if (this.expressionPhase === 'radius') {
      const radius = this.computeRadiusFromMouse(this.mousePoint);

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'R',
          value: String(radius),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onRadiusCommit(result),
        });
      } else {
        this.expressionInput.updateValue(radius);
        this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
      }
    }
  }

  private onWidthCommit(result: CommitResult): void {
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.widthIsNumeric = isNumeric;
    if (isNumeric) {
      this.widthExpression = result;
      this.lockedWidth = num;
    } else {
      this.widthExpression = result;
      this.lockedWidth = null;
    }

    this.expressionPhase = 'height';

    queueMicrotask(() => {
      if (this.mousePoint && this.startPoint) {
        const { height } = this.computeDimensions(this.mousePoint);
        const absH = Math.round(Math.abs(height) * 100) / 100;
        const hSign = height >= 0 ? 1 : -1;
        const anchor = this.dimensionInputAnchor();

        this.expressionInput.show({
          label: 'H',
          value: String(absH),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (r) => this.onHeightCommit(r, hSign),
        });
      }
      this.rebuildPreview();
    });
  }

  private onHeightCommit(result: CommitResult, _heightSign: number): void {
    if (!this.startPoint || !this.widthExpression) {
      return;
    }

    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.heightIsNumeric = isNumeric;
    if (isNumeric) {
      this.heightExpression = result;
      this.lockedHeight = num;
    } else {
      this.heightExpression = result;
      this.lockedHeight = null;
    }

    this.expressionPhase = 'radius';

    queueMicrotask(() => {
      if (this.mousePoint) {
        const radius = this.computeRadiusFromMouse(this.mousePoint);
        const anchor = this.dimensionInputAnchor();
        this.expressionInput.show({
          label: 'R',
          value: String(radius),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (r) => this.onRadiusCommit(r),
        });
      }
      this.rebuildPreview();
    });
  }

  private onRadiusCommit(result: CommitResult): void {
    if (!this.startPoint || !this.widthExpression || !this.heightExpression) {
      return;
    }

    const finalWidth = this.resolveSignedExpression(this.widthExpression, this.widthIsNumeric, this.lockedWidth, 0);
    const finalHeight = this.resolveSignedExpression(this.heightExpression, this.heightIsNumeric, this.lockedHeight, 1);
    this.commitRoundedRect(this.startPoint, finalWidth, finalHeight, result);
    this.resetState();
    this.rebuildPreview();
  }

  private resolveSignedExpression(expr: CommitResult, isNumeric: boolean, absValue: number | null, axis: 0 | 1): CommitResult {
    if (!isNumeric || absValue === null || !this.mousePoint || !this.startPoint || this.shiftHeld) {
      return expr;
    }
    const sign = axis === 0
      ? ((this.mousePoint[0] >= this.startPoint[0]) ? 1 : -1)
      : ((this.mousePoint[1] >= this.startPoint[1]) ? 1 : -1);
    const signed = Math.round(sign * absValue * 100) / 100;
    return { expression: String(signed), newVariable: expr.newVariable };
  }

  private commitDimensionsFromGeometry(endPoint: [number, number]): void {
    if (!this.startPoint) {
      return;
    }

    const { width, height } = this.computeDimensions(endPoint);
    if (width === 0 || height === 0) {
      return;
    }

    this.widthExpression = { expression: String(width) };
    this.lockedWidth = Math.abs(width);
    this.widthIsNumeric = true;
    this.heightExpression = { expression: String(height) };
    this.lockedHeight = Math.abs(height);
    this.heightIsNumeric = true;
    this.expressionPhase = 'radius';
    this.expressionInput.hide();

    if (this.mousePoint) {
      const radius = this.computeRadiusFromMouse(this.mousePoint);
      const anchor = this.dimensionInputAnchor();
      this.expressionInput.show({
        label: 'R',
        value: String(radius),
        clientX: anchor.clientX,
        clientY: anchor.clientY,
        variables: this.cachedVariables,
        onCommit: (r) => this.onRadiusCommit(r),
      });
    }

    this.rebuildPreview();
  }

  private commitRoundedRect(
    start: [number, number],
    widthResult: CommitResult,
    heightResult: CommitResult,
    radiusResult: CommitResult,
  ): void {
    const atCurrent = this.isAtCurrentPosition(start);
    let statement: string;
    if (atCurrent) {
      statement = `rect(${widthResult.expression}, ${heightResult.expression})`;
    } else {
      statement = `rect(${this.formatPoint(start)}, ${widthResult.expression}, ${heightResult.expression})`;
    }

    statement += `.radius(${radiusResult.expression})`;

    if (this.shiftHeld) {
      statement += '.centered()';
    }

    const newVariable = widthResult.newVariable ?? heightResult.newVariable ?? radiusResult.newVariable;
    this.insertGeometry(statement, newVariable);
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.expressionPhase === 'radius') {
        const corners = this.getLockedPreviewCorners();
        if (corners) {
          const radius = this.mousePoint ? this.computeRadiusFromMouse(this.mousePoint) : 0;
          if (radius > 0) {
            addDashedRoundedRect(this.previewGroup, corners.c1, corners.c2, radius, this.plane);
          } else {
            addDashedRect(this.previewGroup, corners.c1, corners.c2, this.plane);
          }
        }
      } else if (this.mousePoint) {
        const { c1, c2 } = this.computePreviewCorners(this.mousePoint);
        addDashedRect(this.previewGroup, c1, c2, this.plane);
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
