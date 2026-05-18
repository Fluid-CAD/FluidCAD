import { ExpressionInput, VariableInfo } from '../../ui/expression-input';
import { updateDimensionExpression, getDimensionExpression } from '../../api';
import { FetchVariablesFn } from '../sketch-tool';
import { DragHitResult, GetSketchSourceLineFn } from './types';

export class DimensionInputController {
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private getSketchSourceLine: GetSketchSourceLineFn;
  private cachedVariables: VariableInfo[] = [];

  standaloneInputActive = false;

  onRequestEndResize: (() => void) | null = null;
  onRequestCloseStandalone: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    fetchVariables: FetchVariablesFn,
    getSketchSourceLine: GetSketchSourceLineFn,
  ) {
    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;
    this.getSketchSourceLine = getSketchSourceLine;
  }

  get isVisible(): boolean {
    return this.expressionInput.isVisible;
  }

  containsElement(target: EventTarget | null): boolean {
    return this.expressionInput.containsElement(target);
  }

  refreshVariables(): Promise<void> {
    return this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  showForDrag(
    hitResult: DragHitResult,
    startPoint: [number, number],
    clientX: number,
    clientY: number,
  ): void {
    const { uniqueType, hitZone } = hitResult;

    let label: string | null = null;
    let value = 0;

    if (uniqueType === 'polygon') {
      label = '⌀';
      const center = hitResult.anchorPoint!;
      const ddx = startPoint[0] - center[0];
      const ddy = startPoint[1] - center[1];
      const newCircumscribedRadius = Math.sqrt(ddx * ddx + ddy * ddy);
      value = hitResult.originalDistance && hitResult.initialValue
        ? Math.round(hitResult.initialValue * newCircumscribedRadius / hitResult.originalDistance * 100) / 100
        : Math.round(2 * newCircumscribedRadius * 100) / 100;
    } else if (uniqueType === 'circle') {
      label = '⌀';
      const center = hitResult.anchorPoint!;
      const ddx = startPoint[0] - center[0];
      const ddy = startPoint[1] - center[1];
      value = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else if ((uniqueType === 'hline' || uniqueType === 'vline') && hitZone === 'end') {
      label = uniqueType === 'hline' ? 'H:' : 'V:';
      const start = hitResult.anchorPoint!;
      value = uniqueType === 'hline'
        ? Math.round(Math.abs(startPoint[0] - start[0]) * 100) / 100
        : Math.round(Math.abs(startPoint[1] - start[1]) * 100) / 100;
    } else if (uniqueType === 'tline' && hitZone === 'end' && hitResult.tangentDir) {
      label = 'T:';
      const start = hitResult.anchorPoint!;
      const t = hitResult.tangentDir;
      const dx = startPoint[0] - start[0];
      const dy = startPoint[1] - start[1];
      value = Math.round(Math.abs(dx * t[0] + dy * t[1]) * 100) / 100;
    } else if (uniqueType === 'slot' && !hitResult.slotHasTwoPoints
               && hitResult.slotOtherCenter && hitResult.slotAxisDir && hitZone === 'end') {
      label = 'D';
      const other = hitResult.slotOtherCenter;
      const ax = hitResult.slotAxisDir;
      const ddx = startPoint[0] - other[0];
      const ddy = startPoint[1] - other[1];
      value = Math.round((ddx * ax[0] + ddy * ax[1]) * 100) / 100;
    } else if (uniqueType === 'slot' && hitZone === 'body') {
      label = 'R';
      const lc = hitResult.anchorPoint!;
      const ddx = startPoint[0] - lc[0];
      const ddy = startPoint[1] - lc[1];
      value = Math.round(Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else if (uniqueType === 'arc' && hitResult.arcIsRadiusMode && hitZone === 'center') {
      label = 'R';
      const startV = hitResult.fixedVertex!;
      const ddx = startPoint[0] - startV[0];
      const ddy = startPoint[1] - startV[1];
      value = Math.round(Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    }

    if (label === null) {
      return;
    }

    this.openInput(label, value, hitResult, clientX, clientY, true);
  }

  showForDoubleClick(
    hitResult: DragHitResult,
    clientX: number,
    clientY: number,
  ): boolean {
    let label: string;
    let value: number;
    if (hitResult.uniqueType === 'polygon' || hitResult.uniqueType === 'circle') {
      label = '⌀';
      value = hitResult.initialValue ?? 0;
    } else if (hitResult.uniqueType === 'hline' || hitResult.uniqueType === 'vline') {
      label = hitResult.uniqueType === 'hline' ? 'H:' : 'V:';
      value = Math.abs(hitResult.initialValue ?? 0);
    } else if (hitResult.uniqueType === 'tline') {
      label = 'T:';
      value = Math.abs(hitResult.initialValue ?? 0);
    } else if (hitResult.uniqueType === 'slot') {
      if (hitResult.hitZone === 'start' || hitResult.hitZone === 'end') {
        if (hitResult.slotHasTwoPoints) {
          return false;
        }
        label = 'D';
        const lc = hitResult.anchorPoint!;
        const rc = hitResult.fixedVertex!;
        const ax = hitResult.slotAxisDir ?? [1, 0];
        value = Math.round(((rc[0] - lc[0]) * ax[0] + (rc[1] - lc[1]) * ax[1]) * 100) / 100;
      } else {
        label = 'R';
        value = hitResult.slotRadius ?? 0;
      }
    } else if (hitResult.uniqueType === 'arc' && hitResult.arcIsRadiusMode && hitResult.hitZone === 'center') {
      label = 'R';
      value = Math.round((hitResult.initialValue ?? 0) * 100) / 100;
    } else {
      return false;
    }

    this.standaloneInputActive = true;
    this.openInput(label, value, hitResult, clientX, clientY, false);
    return true;
  }

  updateValue(
    hitResult: DragHitResult,
    currentPoint: [number, number],
  ): void {
    if (!this.expressionInput.isVisible) {
      return;
    }
    const { uniqueType, anchorPoint } = hitResult;
    let value: number;
    if (uniqueType === 'polygon') {
      const center = anchorPoint!;
      const ddx = currentPoint[0] - center[0];
      const ddy = currentPoint[1] - center[1];
      const newCircumscribedRadius = Math.sqrt(ddx * ddx + ddy * ddy);
      value = hitResult.originalDistance && hitResult.initialValue
        ? Math.round(hitResult.initialValue * newCircumscribedRadius / hitResult.originalDistance * 100) / 100
        : Math.round(2 * newCircumscribedRadius * 100) / 100;
    } else if (uniqueType === 'circle') {
      const center = anchorPoint!;
      const ddx = currentPoint[0] - center[0];
      const ddy = currentPoint[1] - center[1];
      value = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else if (uniqueType === 'tline' && hitResult.tangentDir) {
      const start = anchorPoint!;
      const t = hitResult.tangentDir;
      const dx = currentPoint[0] - start[0];
      const dy = currentPoint[1] - start[1];
      value = Math.round(Math.abs(dx * t[0] + dy * t[1]) * 100) / 100;
    } else if (uniqueType === 'slot' && hitResult.hitZone === 'body') {
      const lc = anchorPoint!;
      const ax = hitResult.slotAxisDir?.[0] ?? 1;
      const ay = hitResult.slotAxisDir?.[1] ?? 0;
      const ddx = currentPoint[0] - lc[0];
      const ddy = currentPoint[1] - lc[1];
      value = Math.round(Math.abs(-ay * ddx + ax * ddy) * 100) / 100;
    } else if (uniqueType === 'slot' && hitResult.slotOtherCenter && hitResult.slotAxisDir) {
      const other = hitResult.slotOtherCenter;
      const ax = hitResult.slotAxisDir;
      const ddx = currentPoint[0] - other[0];
      const ddy = currentPoint[1] - other[1];
      value = Math.round((ddx * ax[0] + ddy * ax[1]) * 100) / 100;
    } else if (uniqueType === 'arc' && hitResult.arcIsRadiusMode) {
      const startV = hitResult.fixedVertex!;
      const ddx = currentPoint[0] - startV[0];
      const ddy = currentPoint[1] - startV[1];
      value = Math.round(Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else {
      const start = anchorPoint!;
      const raw = uniqueType === 'hline'
        ? currentPoint[0] - start[0]
        : currentPoint[1] - start[1];
      value = Math.round(Math.abs(raw) * 100) / 100;
    }
    this.expressionInput.updateValue(value);
  }

  updatePosition(clientX: number, clientY: number): void {
    this.expressionInput.updatePosition(clientX, clientY);
  }

  updateValueIfUnmoved(expression: string): void {
    this.expressionInput.updateValue(expression);
  }

  commitIfVisible(hasMoved: boolean): void {
    if (this.expressionInput.isVisible && hasMoved) {
      this.expressionInput.commitCurrentValue();
    }
  }

  hide(): void {
    this.expressionInput.hide();
  }

  closeStandalone(): void {
    if (!this.standaloneInputActive) {
      return;
    }
    this.standaloneInputActive = false;
    this.expressionInput.hide();
  }

  private openInput(
    label: string,
    value: number,
    hitResult: DragHitResult,
    clientX: number,
    clientY: number,
    isDrag: boolean,
  ): void {
    const { sourceLocation } = hitResult;
    const numericFallback = String(value);

    this.expressionInput.show({
      label,
      value: numericFallback,
      clientX,
      clientY,
      variables: this.cachedVariables,
      onCommit: (result) => {
        const { expression, newVariable } = result;
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;

        let finalExpr = expression;
        if (isNumeric && hitResult.uniqueType !== 'circle' && hitResult.uniqueType !== 'polygon' && hitResult.uniqueType !== 'slot') {
          const sign = this.computeDistanceSign(hitResult, null);
          finalExpr = String(Math.round(sign * num * 100) / 100);
        } else if (isNumeric) {
          finalExpr = String(Math.round(num * 100) / 100);
        }

        const sketchSourceLine = this.getSketchSourceLine();
        const dimOffset = label === 'D' ? 1 : 0;
        updateDimensionExpression(finalExpr, sourceLocation, sketchSourceLine, newVariable, dimOffset);
        if (isDrag) {
          this.onRequestEndResize?.();
        } else {
          this.closeStandalone();
        }
      },
    });

    if (label !== 'D') {
      getDimensionExpression(sourceLocation.line).then(({ expression }) => {
        if (!expression) {
          return;
        }
        if (isDrag) {
          this.updateValueIfUnmoved(expression);
        } else if (this.standaloneInputActive) {
          this.updateValueIfUnmoved(expression);
        }
      });
    }
  }

  private computeDistanceSign(
    hitResult: DragHitResult,
    currentPoint: [number, number] | null,
  ): number {
    if (currentPoint) {
      const start = hitResult.anchorPoint!;
      if (hitResult.uniqueType === 'tline' && hitResult.tangentDir) {
        const t = hitResult.tangentDir;
        const dx = currentPoint[0] - start[0];
        const dy = currentPoint[1] - start[1];
        return (dx * t[0] + dy * t[1]) >= 0 ? 1 : -1;
      }
      if (hitResult.uniqueType === 'hline') {
        return currentPoint[0] >= start[0] ? 1 : -1;
      }
      return currentPoint[1] >= start[1] ? 1 : -1;
    }
    const dist = hitResult.initialValue ?? hitResult.originalDistance ?? 0;
    return dist >= 0 ? 1 : -1;
  }
}
