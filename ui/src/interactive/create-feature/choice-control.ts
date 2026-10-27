import type { FeatureRefValue, NewVariable } from '../../api';
import { OptionButton, type ChoiceItem, type OptionPopoverMode, type ParameterChoice } from '../../ui/controls';
import type { VariableInfo } from '../../ui/expression-core';
import { ChoiceParameters, type ChoiceValue } from './choice-parameters';

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
 * or why nothing can be written — a variable whose value no option carries,
 * or nothing chosen at all.
 */
export type ChoiceRead<V extends ChoiceValue> =
  | { value: V }
  | { ref: string; value?: V; newVariable?: NewVariable }
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
 * with it off). Choosing an option again unbinds. The panel feeds the
 * variables as it gets them and reads `value` for its ghosts and derived
 * lists: the chosen option, or the one the named variable resolves to.
 */
export class ChoiceControl<V extends ChoiceValue> {
  /** The button, in the slot the `<select>` stood in. */
  readonly element: HTMLButtonElement;
  /** The user changed what the control holds — an option or a parameter alike. Never fired by the setters. */
  onChange?: () => void;

  private items: readonly ChoiceItem<V>[];
  private readonly label: string;
  private readonly button: OptionButton<V>;
  private readonly parameters: ChoiceParameters;
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
      parameters: (query, matched) => this.parameters.suggest(query, matched, this.value),
    });
    this.element = this.button.element;
    this.element.dataset.role = options.dataRole;
    this.button.onChange = () => this.takeOption();
    this.button.onBind = choice => this.takeParameter(choice);
  }

  /**
   * The option the control stands on: the chosen one, or the one the named
   * variable's value selects — undefined while nothing is chosen, or the
   * variable's value is unknown or no option's.
   */
  get value(): V | undefined {
    if (this.ref === null) {
      return this.button.value;
    }
    const resolution = this.parameters.resolve(this.ref);
    return resolution.kind === 'options' ? resolution.values[0] as V : undefined;
  }

  /** The variable named in place of an option; undefined while an option (or nothing) is held. */
  get binding(): FeatureRefValue | undefined {
    return this.ref === null ? undefined : { ref: this.ref };
  }

  /** The variables the popover offers; a bound control shows what its name selects by them. */
  setVariables(variables: VariableInfo[]): void {
    this.parameters.variables = variables;
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

  /** Programmatic choice (a seed, a reset); no change fires. `undefined` shows the placeholder. Lets go of a binding. */
  setValue(value: V | undefined): void {
    this.unbind();
    this.button.setValue(value);
  }

  /** Programmatic binding (an edit's parse); no change fires. Resolved through the variables as they stand, and again when they arrive. */
  setRef(ref: string): void {
    this.ref = ref;
    this.declared = null;
    this.parameters.forget();
    this.showBinding();
  }

  /**
   * What the control holds, to write: the chosen option's value; the named
   * variable, with the option it resolves to and the declaration of one
   * declared here; or why nothing can be written.
   */
  read(): ChoiceRead<V> {
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
