import { ExpressionInput } from '../../ui/expression-input';
import { resolveExpressionValue, VariableInfo } from '../../ui/expression-core';

export type GizmoValueUnit = 'mm' | 'deg';

export type GizmoExpressionCommit = {
  /** The committed source expression (the declared name for `myVar = 120`). */
  expression: string;
  /** Client-side evaluation of the expression; null when only a build can. */
  value: number | null;
  newVariable?: { name: string; initializer: string };
};

/**
 * The gizmo's floating value pill, an {@link ExpressionInput} in one of two
 * modes. `show` is the drag readout: arithmetic-only (no variable
 * declarations, no param toggle — the committed text must evaluate to a
 * number, which the host applies as a delta). `showAbsolute` is the
 * axis-click flow: the full expression-input semantics over the axis'
 * absolute source value — references, `name = value` declarations, the param
 * toggle — committing source text the host writes back verbatim. The unit
 * lives in the label; the field holds the bare value.
 */
export class GizmoValueInput {
  private readonly input: ExpressionInput;
  private variables: VariableInfo[] = [];
  /** Bumped on every show/hide so a stale async seed can't land in a field
   *  that has since been reopened for another handle. */
  private sessionToken = 0;

  constructor(container: HTMLElement) {
    this.input = new ExpressionInput(container);
  }

  show(opts: {
    label: string;
    unit: GizmoValueUnit;
    clientX: number;
    clientY: number;
    variables: VariableInfo[];
    initial: number;
    onValue: (value: number) => void;
  }): void {
    this.variables = opts.variables;
    this.sessionToken += 1;
    // The field opens focused with its text selected (ExpressionInput.show),
    // so typing mid-drag immediately replaces the live value — the same
    // type-to-override flow the sketch drag input uses. Pointer capture on
    // the canvas keeps the drag tracking regardless of focus.
    this.input.show({
      label: `${opts.label} (${opts.unit})`,
      value: GizmoValueInput.format(opts.initial),
      clientX: opts.clientX,
      clientY: opts.clientY,
      variables: opts.variables,
      arithmeticOnly: true,
      onCommit: (result) => {
        const value = resolveExpressionValue(result.expression, this.variables);
        if (value !== null) {
          opts.onValue(value);
        }
      },
    });
  }

  /**
   * Absolute mode for a clicked translate arrow: opens on the axis' numeric
   * coordinate and swaps to the exact source expression once the async code
   * read resolves (never once the user types — the same contract as the
   * sketch dimension input's `seedExpression`).
   */
  showAbsolute(opts: {
    label: string;
    unit: GizmoValueUnit;
    clientX: number;
    clientY: number;
    variables: VariableInfo[];
    initial: number;
    /** Resolves with the axis' source text, or null to keep the number. */
    sourceExpression?: Promise<string | null>;
    onCommit: (commit: GizmoExpressionCommit) => void;
  }): void {
    this.variables = opts.variables;
    this.sessionToken += 1;
    const token = this.sessionToken;
    this.input.show({
      label: `${opts.label} (${opts.unit})`,
      value: GizmoValueInput.format(opts.initial),
      clientX: opts.clientX,
      clientY: opts.clientY,
      variables: opts.variables,
      onCommit: (result) => {
        opts.onCommit({
          expression: result.expression,
          value: resolveExpressionValue(
            result.expression, this.variables, result.newVariable ?? null,
          ),
          newVariable: result.newVariable,
        });
      },
    });
    void opts.sourceExpression?.then((expression) => {
      if (expression !== null && token === this.sessionToken) {
        this.input.seedExpression(expression);
      }
    });
  }

  /** Mirror the live drag value (no-op once the user is typing). */
  updateLiveValue(value: number): void {
    this.input.updateValue(value);
  }

  hide(): void {
    this.sessionToken += 1;
    this.input.hide();
  }

  get isVisible(): boolean {
    return this.input.isVisible;
  }

  containsElement(el: EventTarget | null): boolean {
    return this.input.containsElement(el);
  }

  private static format(value: number): string {
    const rounded = Math.round(value * 100) / 100;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }
}
