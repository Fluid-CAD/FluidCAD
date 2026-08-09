import { ExpressionInput } from '../../ui/expression-input';
import { resolveExpressionValue, VariableInfo } from '../../ui/expression-core';

export type GizmoValueUnit = 'mm' | 'deg';

/**
 * The gizmo's floating value pill: an {@link ExpressionInput} in
 * arithmetic-only mode (no variable declarations, no param toggle — the
 * committed text must evaluate to a number, which the host writes into
 * source as a plain literal). The unit lives in the label; the field holds
 * the bare number and mirrors the live drag value until the user types.
 */
export class GizmoValueInput {
  private readonly input: ExpressionInput;
  private variables: VariableInfo[] = [];

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

  /** Mirror the live drag value (no-op once the user is typing). */
  updateLiveValue(value: number): void {
    this.input.updateValue(value);
  }

  hide(): void {
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
