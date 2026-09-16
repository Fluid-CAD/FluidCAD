// Dimension editing for solved sketches (sketch-rewrite P4): double-click a
// dimension glyph (distance / radius / diameter / angle) and the constraint
// statement's scalar rewrites through the existing
// update-dimension-expression rail — the scalar-last-arg convention holds
// for every dimensional constraint command; an axis'd distance keeps its
// trailing 'x'/'y' string, so the scalar sits one non-array arg earlier.
// A statement-owned dimension (an ellipse's RX/RY, P8) rides the same rail
// against its geometry statement: the callee plus the arg offset from the
// end address the scalar, exactly as for a constraint.

import { ExpressionInput, VariableInfo } from '../ui/expression-input';
import { roundToUnitDecimals } from '../units/units';
import { sceneUnit } from '../units/scene-unit';
import { getDimensionExpression, updateDimensionExpression } from '../api';
import type { SolvedConstraintView, StatementDimension } from '../sketch-solver-client';
import type { SourceLocation } from '../types';
import type { FetchVariablesFn } from './sketch-tool';

/** One editable scalar: where it lives and how the input presents it. */
export type DimensionTarget = {
  /** Input pill prefix (`D`, `R`, `⌀`, `∠`, `RX`, `RY`). */
  label: string;
  /** Opening value, in display units. */
  value: number;
  sourceLocation: SourceLocation;
  /** Non-array args from the END of the call — the rail's convention. */
  dimOffset: number;
  /** The callee owning the scalar (`distance`, `ellipse`) — read and write
   * both filter on it, so a chained statement edits the argument the user
   * saw. */
  dimCall: string;
};

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
  /** Bumped per open; a scope read landing for an earlier open is dropped. */
  private openToken = 0;

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

  /** The scalar a dimensional constraint statement edits; null when the
   * constraint has none (or no source to rewrite). */
  static constraintTarget(c: SolvedConstraintView): DimensionTarget | null {
    const label = DIM_LABELS[c.kind];
    const loc = c.obj.sourceLocation;
    if (!label || typeof c.value !== 'number' || !loc) {
      return null;
    }
    // distance(a, b, value, 'x') — the axis string is the last non-array
    // argument, so the scalar sits one earlier.
    const dimOffset = c.spec.kind === 'distance' && c.spec.axis !== undefined ? 1 : 0;
    return { label, value: c.value, sourceLocation: loc, dimOffset, dimCall: c.kind };
  }

  /** The scalar a statement-owned dimension edits (an ellipse's RX/RY);
   * null when the statement has no source to rewrite. */
  static statementTarget(d: StatementDimension): DimensionTarget | null {
    const loc = d.obj.sourceLocation;
    if (!loc) {
      return null;
    }
    return { label: d.label, value: d.value, sourceLocation: loc, dimOffset: d.offset, dimCall: d.call };
  }

  /**
   * Re-read the sketch's scope. The input on screen takes the list the
   * moment it lands — the dimension may name a parameter declared since the
   * last read, and an unknown name would commit as a fresh declaration.
   */
  refreshVariables(): void {
    const token = this.openToken;
    void this.fetchVariables().then((variables) => {
      this.cachedVariables = variables;
      if (token === this.openToken && this.expressionInput.isVisible) {
        this.expressionInput.setVariables(variables);
      }
    });
  }

  /** Open the value input for a dimensional constraint statement. Returns
   * false when the constraint has no editable scalar. */
  show(c: SolvedConstraintView, clientX: number, clientY: number): boolean {
    const target = SolvedDimensionEditor.constraintTarget(c);
    if (!target) {
      return false;
    }
    this.open(target, clientX, clientY);
    return true;
  }

  /** Open the value input for a statement-owned dimension (an ellipse's
   * RX/RY). Returns false when the statement has no source to rewrite. */
  showStatementDimension(d: StatementDimension, clientX: number, clientY: number): boolean {
    const target = SolvedDimensionEditor.statementTarget(d);
    if (!target) {
      return false;
    }
    this.open(target, clientX, clientY);
    return true;
  }

  private open(target: DimensionTarget, clientX: number, clientY: number): void {
    const { label, sourceLocation: loc, dimOffset, dimCall } = target;
    this.openToken++;
    const token = this.openToken;

    this.expressionInput.show({
      label,
      // Seed rounded to the document unit's display decimals; what the user
      // types is never re-rounded except the historical mm 2-decimal tidy-up.
      value: String(roundToUnitDecimals(target.value, sceneUnit.current)),
      clientX,
      clientY,
      variables: this.cachedVariables,
      onCommit: ({ expression, newVariable }) => {
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;
        const finalExpr = isNumeric && sceneUnit.current === 'mm' ? String(Math.round(num * 100) / 100) : expression;
        updateDimensionExpression(
          finalExpr,
          loc,
          this.getSketchSourceLine(),
          newVariable,
          dimOffset,
          dimCall,
        );
        this.hide();
      },
    });
    document.addEventListener('pointerdown', this.boundOutsidePointerDown, { capture: true });

    // Upgrade the numeric opening value to the source expression once the
    // code read lands (`w / 2` instead of 12.5) — unless the user typed.
    void getDimensionExpression(loc.line, dimOffset, dimCall).then(({ expression }) => {
      if (expression && token === this.openToken && this.expressionInput.isVisible) {
        this.expressionInput.seedExpression(expression);
      }
    });
    // The opening list is last read's; the fresh one replaces it in place.
    this.refreshVariables();
  }

  hide(): void {
    document.removeEventListener('pointerdown', this.boundOutsidePointerDown, { capture: true });
    this.expressionInput.hide();
  }
}
