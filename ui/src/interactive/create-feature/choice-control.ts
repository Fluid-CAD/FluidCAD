import type { FeatureExprValue, FeatureRefValue, NewVariable } from '../../api';
import { OptionButton, type ChoiceItem, type OptionPopoverMode, type ParameterChoice } from '../../ui/controls';
import { choiceLiteral, type VariableInfo, type VariableLiteral } from '../../ui/expression-core';
import { ChoiceParameters, type ChoiceValue } from './choice-parameters';
import { ExpressionMode, type ExpressionShown } from './expression-mode';
import { literalText } from './expression-rows';

export interface ChoiceControlOptions<V extends ChoiceValue> {
  items: readonly ChoiceItem<V>[];
  /** The chosen item's value; nothing chosen without one. */
  value?: V;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** The search box, where a parameter's name is typed: on unless turned off. */
  search?: boolean;
  /** The popover's layout and, in a grid, its columns (see `OptionPopoverOptions`). */
  mode?: OptionPopoverMode;
  columns?: number;
  /** The row's label, for the messages ("Size: screw is 'm9', which is not one of the options."). */
  label: string;
  /** The `data-role` the button wears — the one the `<select>` it replaces wore, so the panel's tests and selectors keep working. */
  dataRole: string;
}

/**
 * What the control holds, as its panel writes it: the chosen option's value;
 * a variable named in place of one (with what it resolves to when known, and
 * the declaration of a parameter declared here, to land with the statement);
 * an expression in place of one (with the option it comes to when known);
 * or why nothing can be written — a variable whose value no option carries,
 * an empty expression, or nothing chosen at all.
 */
export type ChoiceRead<V extends ChoiceValue> =
  | { value: V }
  | { ref: string; value?: V; newVariable?: NewVariable }
  | { expr: string; value?: V }
  | { error: string };

/**
 * A dropdown of a hand-rolled feature dialog (hole size, split keep, text
 * font, …) that lists the parameters in scope under its options: an
 * `OptionButton` and its popover over `ChoiceParameters`, the pairing the
 * schema dialog's `SelectField` makes for a custom feature's select rows.
 * A parameter picked from the list stands in for the option — the button
 * shows its name with the option it selects muted beside it — and the
 * control reads as `{ ref }`; a fresh name typed in the search box declares
 * one over the option shown (a `param()` with the P toggle on, the literal
 * with it off). Choosing an option again unbinds. The ƒ toggle (`toggle`,
 * which the panel puts on the row's label line) turns the control into an
 * expression input in place of an option — `left ? 'close' : 'loose'` — the
 * option it comes to shown muted underneath, exactly as a schema dialog's
 * select does; the control then reads `{ expr }`, and a statement holding an
 * expression opens it in that mode. The panel feeds the variables as it
 * gets them and reads `value` for its ghosts and derived lists: the chosen
 * option, or the one the named variable or the expression resolves to.
 */
export class ChoiceControl<V extends ChoiceValue> {
  /** The button, in the slot the `<select>` stood in. */
  readonly element: HTMLButtonElement;
  /** The ƒ toggle, for the row's label line; its expression line follows the button on its own. */
  readonly toggle: HTMLButtonElement;
  /** The user changed what the control holds — an option, a parameter or an expression alike. Never fired by the setters. */
  onChange?: () => void;
  /** Enter in the expression input. */
  onSubmit?: () => void;

  private items: readonly ChoiceItem<V>[];
  private readonly label: string;
  private readonly button: OptionButton<V>;
  private readonly parameters: ChoiceParameters;
  private readonly mode: ExpressionMode;
  /** The variable named in place of an option, or null while an option (or nothing) is held. */
  private ref: string | null = null;
  /** The parameter the control declared itself over the option it showed: written with the statement. */
  private declared: NewVariable | null = null;

  constructor(options: ChoiceControlOptions<V>) {
    this.items = options.items;
    this.label = options.label;
    this.parameters = new ChoiceParameters(options.label, () => this.items, false);
    this.button = new OptionButton<V>({
      items: options.items,
      value: options.value,
      placeholder: options.placeholder,
      mode: options.mode,
      columns: options.columns,
      search: options.search ?? true,
      parameters: (query, matched) => this.parameters.suggest(query, matched, this.value, this.ref),
    });
    this.element = this.button.element;
    this.element.dataset.role = options.dataRole;
    this.button.onChange = () => this.takeOption();
    this.button.onBind = choice => this.takeParameter(choice);
    this.mode = new ExpressionMode({
      name: options.dataRole,
      label: options.label,
      seed: () => this.sourceOfHeld(),
      describe: value => this.describe(value),
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.onChange?.();
    this.mode.onSubmit = () => this.onSubmit?.();
    this.toggle = this.mode.toggle;
  }

  /**
   * The option the control stands on: the chosen one, the one the named
   * variable's value selects, or the one its expression comes to — undefined
   * while nothing is chosen, or the variable's value or the expression's is
   * unknown or no option's.
   */
  get value(): V | undefined {
    if (this.mode.on) {
      return this.expressionValue();
    }
    if (this.ref === null) {
      return this.button.value;
    }
    const resolution = this.parameters.resolve(this.ref);
    return resolution.kind === 'options' ? resolution.values[0] as V : undefined;
  }

  /** The variable named in place of an option; undefined while an option, an expression (or nothing) is held. */
  get binding(): FeatureRefValue | undefined {
    return this.ref === null || this.mode.on ? undefined : { ref: this.ref };
  }

  /** The expression held in place of an option; undefined while the mode is off. */
  get expression(): FeatureExprValue | undefined {
    const read = this.mode.on ? this.mode.read() : null;
    return read && 'value' in read ? read.value : undefined;
  }

  /** The variables the popover and the expression input offer; a bound control shows what its name selects by them, an expression what it comes to. */
  setVariables(variables: VariableInfo[]): void {
    this.parameters.variables = variables;
    this.mode.setVariables(variables);
    if (this.ref !== null) {
      this.showBinding();
    }
  }

  /** Replace the options; an open popover closes. A chosen value stays while an item still carries it; a binding stays, re-resolved. */
  setItems(items: readonly ChoiceItem<V>[]): void {
    this.items = items;
    this.button.setItems(items);
    if (this.ref !== null) {
      this.showBinding();
      return;
    }
    const held = this.button.value;
    if (held !== undefined && !items.some(item => item.value === held)) {
      this.button.setValue(undefined);
    }
  }

  /** Programmatic choice (a seed, a reset); no change fires. `undefined` shows the placeholder. Lets go of a binding and of an expression. */
  setValue(value: V | undefined): void {
    this.leaveExpression();
    this.unbind();
    this.button.setValue(value);
  }

  /** Programmatic binding (an edit's parse); no change fires. Resolved through the variables as they stand, and again when they arrive. Lets go of an expression. */
  setRef(ref: string): void {
    this.leaveExpression();
    this.ref = ref;
    this.declared = null;
    this.parameters.forget();
    this.showBinding();
  }

  /**
   * Programmatic expression (an edit's parse); no change fires. The mode
   * opens on the text, the button put away underneath on the option the
   * text comes to (for the way back), a binding let go.
   */
  setExpr(expr: string): void {
    this.unbind();
    this.placeExpression();
    this.mode.show(expr);
    this.element.classList.add('hidden');
    this.button.setValue(this.expressionValue());
  }

  /**
   * What the control holds, to write: the chosen option's value; the named
   * variable, with the option it resolves to and the declaration of one
   * declared here; the expression, with the option it comes to; or why
   * nothing can be written.
   */
  read(): ChoiceRead<V> {
    if (this.mode.on) {
      const read = this.mode.read();
      if ('error' in read) {
        return read;
      }
      const value = this.expressionValue();
      return value === undefined ? { expr: read.value.expr } : { expr: read.value.expr, value };
    }
    if (this.ref !== null) {
      return this.readBinding(this.ref);
    }
    const value = this.button.value;
    if (value === undefined) {
      return { error: `${this.label} needs a choice.` };
    }
    return { value };
  }

  close(): void {
    this.button.close();
  }

  destroy(): void {
    this.button.destroy();
    this.mode.destroy();
  }

  /** The option the expression comes to, when it comes to one the control offers; undefined otherwise. */
  private expressionValue(): V | undefined {
    const value = this.mode.value();
    if (value === undefined || typeof value === 'boolean' || Array.isArray(value)) {
      return undefined;
    }
    return this.items.some(item => item.value === value) ? value as V : undefined;
  }

  /** What the control holds as source, for an expression to start from: a named variable, an option; empty for nothing. */
  private sourceOfHeld(): string {
    if (this.ref !== null) {
      return this.ref;
    }
    const value = this.button.value;
    return value === undefined ? '' : choiceLiteral(value);
  }

  /** How the control shows the literal its expression comes to: the option's label, muted — or the value under a warning when it is no option's. */
  private describe(value: VariableLiteral): ExpressionShown {
    const item = typeof value === 'boolean' || Array.isArray(value) ? undefined : this.items.find(each => each.value === value);
    return item
      ? { text: item.label }
      : { text: literalText(value), warning: `${this.mode.text} is ${literalText(value)}, which is not one of the options.` };
  }

  /**
   * The user pressed ƒ: on, a named variable lets go (the name is the
   * expression's start) and the button gives way; off, the button is back
   * on the option the expression came to, when it came to one.
   */
  private toggleMode(on: boolean): void {
    if (on) {
      if (this.ref !== null) {
        const resolution = this.parameters.resolve(this.ref);
        this.unbind();
        this.button.setValue(resolution.kind === 'options' ? resolution.values[0] as V : undefined);
      }
      this.placeExpression();
    } else {
      const resolved = this.expressionValue();
      if (resolved !== undefined) {
        this.button.setValue(resolved);
      }
    }
    this.element.classList.toggle('hidden', on);
  }

  /** The expression line follows the button in its slot — put there the first time it is needed. */
  private placeExpression(): void {
    if (this.mode.line.parentElement !== this.element.parentElement) {
      this.element.after(this.mode.line);
    }
  }

  /** The control holds an option (or a variable) again: the expression goes. */
  private leaveExpression(): void {
    this.mode.clear();
    this.element.classList.remove('hidden');
  }

  private readBinding(ref: string): ChoiceRead<V> {
    const error = this.parameters.error(ref);
    if (error !== null) {
      return { error };
    }
    const value = this.value;
    const read: ChoiceRead<V> = value === undefined ? { ref } : { ref, value };
    return this.declared ? { ...read, newVariable: this.declared } : read;
  }

  private showBinding(): void {
    this.button.setBinding(this.parameters.binding(this.ref!));
  }

  /** The control holds an option (or nothing) again: the name and any declaration go. */
  private unbind(): void {
    this.ref = null;
    this.declared = null;
    this.parameters.forget();
  }

  /** The user chose an option: the control is its own again. */
  private takeOption(): void {
    this.unbind();
    this.onChange?.();
  }

  /** The user chose a parameter row: an existing variable, or the offer to declare one over what the control showed when it was offered. */
  private takeParameter(choice: ParameterChoice): void {
    if (choice.isNew) {
      const declared = this.parameters.declare(choice.name);
      if (!declared) {
        return;
      }
      this.declared = declared;
    } else {
      this.declared = null;
      this.parameters.forget();
    }
    this.ref = choice.name;
    this.showBinding();
    this.onChange?.();
  }
}
