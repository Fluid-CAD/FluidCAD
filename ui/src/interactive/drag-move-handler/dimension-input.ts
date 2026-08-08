import { ExpressionInput, VariableInfo } from '../../ui/expression-input';
import { updateDimensionExpression, getDimensionExpression } from '../../api';
import { FetchVariablesFn, SketchTool } from '../sketch-tool';
import { computeFixedRadiusArc } from './constraint-math';
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
    } else if ((uniqueType === 'tline' || uniqueType === 'aline') && hitZone === 'end' && hitResult.tangentDir) {
      label = uniqueType === 'tline' ? 'T:' : 'L:';
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
    } else if (uniqueType === 'tarc-radius-to-point' && hitZone === 'center') {
      label = 'R:';
      const start = hitResult.anchorPoint!;
      const ddx = startPoint[0] - start[0];
      const ddy = startPoint[1] - start[1];
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
    } else if (hitResult.uniqueType === 'aline' && hitResult.hitZone === 'angle') {
      // The angle is signed (CCW positive, matching the indicator readout),
      // so it is shown and committed as-is rather than as a magnitude.
      label = 'A:';
      value = hitResult.initialValue ?? 0;
    } else if (hitResult.uniqueType === 'tline' || hitResult.uniqueType === 'aline') {
      label = hitResult.uniqueType === 'tline' ? 'T:' : 'L:';
      value = Math.abs(hitResult.initialValue ?? 0);
    } else if (hitResult.uniqueType === 'rect') {
      if (!hitResult.rectDim) {
        return false;
      }
      if (hitResult.rectDim === 'radius') {
        label = 'R:';
        value = hitResult.initialValue ?? 0;
      } else {
        label = hitResult.rectDim === 'width' ? 'W:' : 'H:';
        value = Math.abs(hitResult.initialValue ?? 0);
      }
    } else if ((hitResult.uniqueType === 'tarc-to-point' || hitResult.uniqueType === 'tarc-radius-to-point')
               && (hitResult.hitZone === 'body' || hitResult.hitZone === 'center')) {
      // Double-clicking a tangent arc's curve (or center) sets its radius.
      // On a radius-less `tArc([e])` the commit inserts the radius argument,
      // converting the statement to the `tArc(radius, [e])` overload. The
      // input shows the magnitude; the stored sign (leave side) is
      // re-applied on commit via the signed-dimension machinery.
      label = 'R:';
      value = Math.abs(hitResult.initialValue ?? 0);
      if (!(value > 0)) {
        return false;
      }
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
    } else if ((uniqueType === 'tline' || uniqueType === 'aline') && hitResult.tangentDir) {
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
    } else if (uniqueType === 'tarc-radius-to-point' && hitResult.hitZone === 'center') {
      const start = anchorPoint!;
      const ddx = currentPoint[0] - start[0];
      const ddy = currentPoint[1] - start[1];
      value = Math.round(Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else if (uniqueType === 'slot' && hitResult.slotOtherCenter && hitResult.slotAxisDir) {
      const other = hitResult.slotOtherCenter;
      const ax = hitResult.slotAxisDir;
      const ddx = currentPoint[0] - other[0];
      const ddy = currentPoint[1] - other[1];
      value = Math.round((ddx * ax[0] + ddy * ax[1]) * 100) / 100;
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

  seedExpressionIfUnmoved(expression: string): void {
    this.expressionInput.seedExpression(expression);
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
    const { offset: dimOffset, call: dimCall, insert: dimInsert } = DimensionInputController.dimensionTargetFor(hitResult, label);
    const isSignedType = hitResult.uniqueType !== 'circle'
      && hitResult.uniqueType !== 'polygon'
      && hitResult.uniqueType !== 'slot'
      && hitResult.hitZone !== 'angle';

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
        if (isSignedType) {
          const sign = this.computeDistanceSign(hitResult, null);
          finalExpr = SketchTool.applySignedDimension(expression, sign);
        } else if (isNumeric) {
          finalExpr = String(Math.round(num * 100) / 100);
        }

        // A tArc radius commit also re-aims the endpoint argument at the
        // position the new tangent circle can actually reach.
        const dimPoint = dimInsert
          ? DimensionInputController.projectedTArcEndpoint(
              hitResult,
              isNumeric ? num : (newVariable ? parseFloat(newVariable.initializer) : NaN),
            )
          : null;

        const sketchSourceLine = this.getSketchSourceLine();
        updateDimensionExpression(finalExpr, sourceLocation, sketchSourceLine, newVariable, dimOffset, dimCall, dimInsert, dimPoint);
        if (isDrag) {
          this.onRequestEndResize?.();
        } else {
          this.closeStandalone();
        }
      },
    });

    if (label !== 'D') {
      getDimensionExpression(sourceLocation.line, dimOffset, dimCall).then(({ expression }) => {
        if (!expression) {
          return;
        }
        const seed = isSignedType
          ? DimensionInputController.stripNegation(expression)
          : expression;
        if (isDrag || this.standaloneInputActive) {
          this.seedExpressionIfUnmoved(seed);
        }
      });
    }
  }

  // Which call in the member chain and which non-array arg (offset from the
  // end) holds the dimension: rect width/height live in rect(...), a fillet
  // radius in .radius(...); the slot distance ('D') sits one arg before its
  // radius in the same call. `insert` marks a dimension the statement may
  // not carry yet — the edit adds it as the call's first argument.
  private static dimensionTargetFor(
    hitResult: DragHitResult,
    label: string,
  ): { offset: number; call: string | null; insert?: boolean } {
    if (hitResult.uniqueType === 'rect') {
      if (hitResult.rectDim === 'radius') {
        return { offset: hitResult.rectRadiusArgOffset ?? 0, call: 'radius' };
      }
      return { offset: hitResult.rectDim === 'width' ? 1 : 0, call: 'rect' };
    }
    if (hitResult.uniqueType === 'aline' && hitResult.hitZone === 'angle') {
      // aLine(angle, length): the angle sits one arg before the length, and
      // only in the aLine call itself — a chained .centered(true) would
      // otherwise satisfy a call-agnostic offset.
      return { offset: 1, call: 'aLine' };
    }
    if (hitResult.uniqueType === 'tarc-to-point' || hitResult.uniqueType === 'tarc-radius-to-point') {
      // The radius is tArc's only scalar; a radius-less `tArc([e])` gains it
      // as the first argument, becoming the `tArc(radius, [e])` overload.
      return { offset: 0, call: 'tArc', insert: true };
    }
    return { offset: label === 'D' ? 1 : 0, call: null };
  }

  // Where the arc will actually end for the committed radius: the current
  // endpoint (the aim) projected onto the new tangent circle. The typed
  // value's sign composes with the measured leave direction, so passing it
  // with the built arc's tangent handles negative radii. Null when the
  // radius isn't statically known (a pre-existing variable expression) —
  // the endpoint argument then stays as the aim and the kernel projects.
  private static projectedTArcEndpoint(
    hitResult: DragHitResult,
    typedValue: number,
  ): [number, number] | null {
    if (!Number.isFinite(typedValue) || typedValue === 0) {
      return null;
    }
    const start = hitResult.anchorPoint;
    const aim = hitResult.fixedVertex2;
    const tangent = hitResult.tangentDir;
    if (!start || !aim || !tangent) {
      return null;
    }
    const arc = computeFixedRadiusArc(start, aim, typedValue, tangent);
    if (!arc) {
      return null;
    }
    return [Math.round(arc.end[0] * 100) / 100, Math.round(arc.end[1] * 100) / 100];
  }

  // Inverse of SketchTool.applySignedDimension, for seeding the input: the
  // input always shows a positive magnitude and the stored sign is re-applied
  // on commit, so a stored `-50` / `-(w)` seeds as `50` / `w`.
  private static stripNegation(expression: string): string {
    const trimmed = expression.trim();
    const num = parseFloat(trimmed);
    if (!isNaN(num) && String(num) === trimmed) {
      return String(Math.abs(num));
    }
    if (/^-[a-zA-Z_$][\w$]*$/.test(trimmed)) {
      return trimmed.slice(1);
    }
    if (trimmed.startsWith('-(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(2, -1);
      let depth = 0;
      for (const ch of inner) {
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth < 0) {
            return trimmed;
          }
        }
      }
      if (depth === 0) {
        return inner;
      }
    }
    return trimmed;
  }

  private computeDistanceSign(
    hitResult: DragHitResult,
    currentPoint: [number, number] | null,
  ): number {
    if (currentPoint) {
      const start = hitResult.anchorPoint!;
      if ((hitResult.uniqueType === 'tline' || hitResult.uniqueType === 'aline') && hitResult.tangentDir) {
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
