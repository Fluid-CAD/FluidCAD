// Dimension editing for solved sketches (sketch-rewrite P4): double-click a
// dimension glyph (distance / radius / diameter / angle) and the constraint
// statement's scalar rewrites through the existing
// update-dimension-expression rail — the scalar-last-arg convention holds
// for every dimensional constraint command; an axis'd distance keeps its
// trailing 'x'/'y' string, so the scalar sits one non-array arg earlier.

import { ExpressionInput, VariableInfo } from '../ui/expression-input';
import { getDimensionExpression, updateDimensionExpression } from '../api';
import type { SolvedConstraintView } from '../sketch-solver-client';
import type { FetchVariablesFn } from './sketch-tool';

const DIM_LABELS: Record<string, string> = {
  distance: 'D',
  radius: 'R',
  diameter: '⌀',
  angle: '∠',
};

export class SolvedDimensionEditor {
  private expressionInput: ExpressionInput;
  private cachedVariables: VariableInfo[] = [];
  private boundOutsidePointerDown: (e: PointerEvent) => void;

  constructor(
    container: HTMLElement,
    private fetchVariables: FetchVariablesFn,
    private getSketchSourceLine: () => number | null,
  ) {
    this.expressionInput = new ExpressionInput(container);
    this.boundOutsidePointerDown = (e: PointerEvent) => {
      if (!this.expressionInput.containsElement(e.target)) {
        this.hide();
      }
    };
  }

  get isVisible(): boolean {
    return this.expressionInput.isVisible;
  }

  /** True when the constraint carries an editable scalar. */
  static isDimensional(c: SolvedConstraintView): boolean {
    return DIM_LABELS[c.kind] !== undefined && typeof c.value === 'number';
  }

  refreshVariables(): void {
    void this.fetchVariables().then((variables) => {
      this.cachedVariables = variables;
    });
  }

  /** Open the value input for a dimensional constraint statement. Returns
   * false when the constraint has no editable scalar. */
  show(c: SolvedConstraintView, clientX: number, clientY: number): boolean {
    const label = DIM_LABELS[c.kind];
    const loc = c.obj.sourceLocation;
    if (!label || typeof c.value !== 'number' || !loc) {
      return false;
    }
    // distance(a, b, value, 'x') — the axis string is the last non-array
    // argument, so the scalar sits one earlier.
    const dimOffset = c.spec.kind === 'distance' && c.spec.axis !== undefined ? 1 : 0;
    const dimCall = c.kind;

    this.expressionInput.show({
      label,
      value: String(Math.round(c.value * 100) / 100),
      clientX,
      clientY,
      variables: this.cachedVariables,
      onCommit: ({ expression, newVariable }) => {
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;
        const finalExpr = isNumeric ? String(Math.round(num * 100) / 100) : expression;
        updateDimensionExpression(
          finalExpr,
          loc,
          this.getSketchSourceLine(),
          newVariable,
          dimOffset,
        );
        this.hide();
      },
    });
    document.addEventListener('pointerdown', this.boundOutsidePointerDown, { capture: true });

    // Upgrade the numeric opening value to the source expression once the
    // code read lands (`w / 2` instead of 12.5) — unless the user typed.
    void getDimensionExpression(loc.line, dimOffset, dimCall).then(({ expression }) => {
      if (expression && this.expressionInput.isVisible) {
        this.expressionInput.seedExpression(expression);
      }
    });
    return true;
  }

  hide(): void {
    document.removeEventListener('pointerdown', this.boundOutsidePointerDown, { capture: true });
    this.expressionInput.hide();
  }
}
