import type { FeatureExprValue, FeatureRefValue } from '../../api';
import { choiceLiteral, type VariableInfo, type VariableLiteral } from '../../ui/expression-core';
import { ExpressionMode, type ExpressionShown } from './expression-mode';

/** A literal as a row's note says it: a text's as source, a boolean as it is. */
export function literalText(value: VariableLiteral): string {
  return typeof value === 'boolean' ? String(value) : choiceLiteral(value);
}

/**
 * A statement's choice slot as a select or tab row seeds it: a reference
 * (`{ keep: side }`) opens as the expression of its name — these rows have
 * no binding of their own, and the name written bare is the same text, so a
 * row left alone writes the statement back as it was.
 */
export function choiceSeed<V extends string>(value: V | FeatureRefValue | FeatureExprValue): V | FeatureExprValue {
  return typeof value === 'object' && 'ref' in value ? { expr: value.ref } : value;
}

/** A row's label line: the label, and the ƒ toggle at the far end. */
const LABEL_LINE_CLASS = 'flex items-center justify-between gap-2';

/** Ids handed to controls whose `<label>` row needs pinning. */
let pinned = 0;

/**
 * Keep a `<label>` row's click on its own control once the ƒ toggle joins
 * it: a button is a labelable element, and a label with no `for` activates
 * the first one in it — which would be the toggle, ahead of the box or the
 * input. Pinning the label to the control by id leaves the toggle a button
 * of its own. A control outside any label needs nothing.
 */
function pinLabel(control: HTMLElement): void {
  const label = control.closest('label');
  if (!label) {
    return;
  }
  if (control.id === '') {
    control.id = `expression-row-${++pinned}`;
  }
  label.htmlFor = control.id;
}

/**
 * Put a row's ƒ toggle at the far end of its label: the label text (a
 * `<span>` in the panel's markup) gives way to a line holding it and the
 * toggle. The hand-rolled dialogs lay their rows out in HTML strings, so a
 * control joins the label after the fact rather than building the row.
 */
export function withExpressionToggle(label: HTMLElement, toggle: HTMLButtonElement): HTMLElement {
  const line = document.createElement('div');
  line.className = LABEL_LINE_CLASS;
  label.replaceWith(line);
  line.append(label, toggle);
  return line;
}

/**
 * A built-in dialog's yes/no row with the ƒ mode beside it — the extrude's
 * drill-holes toggle, a repeat's centered box: the panel's own `<input
 * type="checkbox">`, joined by the toggle before it and, under the row, the
 * expression line. In expression mode the box gives way (hidden and
 * disabled, so the label's click does nothing) to an expression that
 * evaluates to true or false, shown with what it comes to; a statement
 * holding one (`drill(flag)`) opens the row in that mode, and leaving it
 * lands the box on the value the expression came to. The row reads a
 * boolean, or `{ expr }` while the mode is on.
 */
export class FlagControl {
  /** The user ticked the box or changed the expression; never fired by the setters. */
  onChange?: () => void;
  /** Enter in the expression input. */
  onSubmit?: () => void;

  readonly mode: ExpressionMode;

  constructor(private readonly input: HTMLInputElement, options: { name: string; label: string }) {
    this.mode = new ExpressionMode({
      name: options.name,
      label: options.label,
      seed: () => String(this.input.checked),
      describe: value => FlagControl.describe(this.mode.text, value),
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.onChange?.();
    this.mode.onSubmit = () => this.onSubmit?.();
    // The toggle sits between the label and the box; the box keeps the end of the line.
    const end = document.createElement('span');
    end.className = 'flex items-center gap-2';
    const row = this.input.parentElement!;
    this.input.replaceWith(end);
    end.append(this.mode.toggle, this.input);
    row.after(this.mode.line);
    pinLabel(this.input);
    this.input.addEventListener('change', () => this.onChange?.());
  }

  /** How a flag row shows the literal its expression comes to: the boolean, or the value under a warning. */
  static describe(text: string, value: VariableLiteral): ExpressionShown {
    return typeof value === 'boolean'
      ? { text: String(value) }
      : { text: literalText(value), warning: `${text} is ${literalText(value)}, which is not true or false.` };
  }

  /** The flag the row stands on: the box's, or the one its expression comes to — undefined while that is unknown. */
  get checked(): boolean | undefined {
    if (this.mode.on) {
      const value = this.mode.value();
      return typeof value === 'boolean' ? value : undefined;
    }
    return this.input.checked;
  }

  /** The mode is on: the row holds an expression. */
  get on(): boolean {
    return this.mode.on;
  }

  /** What the row writes: the box's flag, or the expression. */
  read(): { value: boolean | FeatureExprValue } | { error: string } {
    return this.mode.on ? this.mode.read() : { value: this.input.checked };
  }

  /** Programmatic value (a seed, a reset); no change fires. An expression opens the mode, the box underneath on what it comes to. */
  setValue(value: boolean | FeatureExprValue): void {
    if (ExpressionMode.isExpr(value)) {
      this.mode.show(value.expr);
      this.hideInput(true);
      this.input.checked = this.mode.value() === true;
      return;
    }
    this.mode.clear();
    this.hideInput(false);
    this.input.checked = value;
  }

  /** The variables the expression completes and resolves over. */
  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
  }

  destroy(): void {
    this.mode.destroy();
  }

  /** The box gives way to the expression, and takes its place again on what the expression comes to, when it comes to true or false. */
  private toggleMode(on: boolean): void {
    if (!on) {
      const resolved = this.mode.value();
      if (typeof resolved === 'boolean') {
        this.input.checked = resolved;
      }
    }
    this.hideInput(on);
  }

  private hideInput(hidden: boolean): void {
    this.input.classList.toggle('hidden', hidden);
    this.input.disabled = hidden;
  }
}

/**
 * A built-in dialog's text row with the ƒ mode beside it — a text's string,
 * a colour's value: the panel's own `<input>` (or the `<textarea>` a
 * multi-line text takes), its label line taking the toggle and the
 * expression line following the input. In expression mode
 * the input gives way to an expression that evaluates to a string — a
 * template string, a name, a concatenation — shown as the text it comes to;
 * a statement holding one (`` text(`rib-${n}`) ``) opens the row in that
 * mode, and leaving it lands the input on that text. The row reads a
 * string, or `{ expr }` while the mode is on.
 */
export class TextControl {
  /** The user typed in the input or changed the expression; never fired by the setters. */
  onChange?: () => void;
  /** Enter in the expression input. */
  onSubmit?: () => void;

  readonly mode: ExpressionMode;

  constructor(
    private readonly input: HTMLInputElement | HTMLTextAreaElement,
    label: HTMLElement,
    options: { name: string; label: string },
  ) {
    this.mode = new ExpressionMode({
      name: options.name,
      label: options.label,
      seed: () => choiceLiteral(this.input.value),
      describe: value => TextControl.describe(this.mode.text, value),
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.onChange?.();
    this.mode.onSubmit = () => this.onSubmit?.();
    withExpressionToggle(label, this.mode.toggle);
    this.input.after(this.mode.line);
    pinLabel(this.input);
    this.input.addEventListener('input', () => this.onChange?.());
  }

  /** How a text row shows the literal its expression comes to: the text as source, or the value under a warning. */
  static describe(text: string, value: VariableLiteral): ExpressionShown {
    return typeof value === 'string'
      ? { text: choiceLiteral(value) }
      : { text: literalText(value), warning: `${text} is ${literalText(value)}, which is not text.` };
  }

  /** The text the row stands on: the input's, or the one its expression comes to — undefined while that is unknown. */
  get text(): string | undefined {
    if (this.mode.on) {
      const value = this.mode.value();
      return typeof value === 'string' ? value : undefined;
    }
    return this.input.value;
  }

  /** The mode is on: the row holds an expression. */
  get on(): boolean {
    return this.mode.on;
  }

  /** What the row writes: the input's text, or the expression. The panel keeps its own say on an empty text. */
  read(): { value: string | FeatureExprValue } | { error: string } {
    return this.mode.on ? this.mode.read() : { value: this.input.value };
  }

  /** Programmatic value (a seed, a reset); no change fires. An expression opens the mode, the input underneath on what it comes to. */
  setValue(value: string | FeatureExprValue): void {
    if (ExpressionMode.isExpr(value)) {
      this.mode.show(value.expr);
      this.input.classList.add('hidden');
      const resolved = this.mode.value();
      this.input.value = typeof resolved === 'string' ? resolved : '';
      return;
    }
    this.mode.clear();
    this.input.classList.remove('hidden');
    this.input.value = value;
  }

  /** The variables the expression completes and resolves over. */
  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
  }

  destroy(): void {
    this.mode.destroy();
  }

  /** The input gives way to the expression, and takes its place again on the text the expression comes to, when it comes to one. */
  private toggleMode(on: boolean): void {
    if (!on) {
      const resolved = this.mode.value();
      if (typeof resolved === 'string') {
        this.input.value = resolved;
      }
    }
    this.input.classList.toggle('hidden', on);
  }
}

/** One option a dropdown or tab row offers, as its expression line names it. */
export type OptionLabel<V extends string> = { value: V; label: string };

/**
 * A built-in dialog's `<select>` row with the ƒ mode beside it — a split's
 * keep, a loft condition's type, a connector's rotation axis: the panel's
 * own `<select>`, its label line taking the toggle and the expression line
 * following it. In expression mode the select gives way to an expression
 * that evaluates to one of its options' values (`flag ? 'front' : 'back'`),
 * shown by that option's label — or the value under a warning when it is
 * none of them; a statement holding one opens the row in that mode, and
 * leaving it lands the select on the option the expression came to. The
 * row reads an option's value, or `{ expr }` while the mode is on. A
 * `numeric` select's options stand for numbers (a text's weight): its
 * expression comes to a number, which selects the option spelling it, and
 * the ƒ toggle seeds the chosen option bare.
 */
export class SelectControl<V extends string> {
  /** The user chose an option or changed the expression; never fired by the setters. */
  onChange?: () => void;
  /** Enter in the expression input. */
  onSubmit?: () => void;

  readonly mode: ExpressionMode;
  private readonly numeric: boolean;

  constructor(
    private readonly select: HTMLSelectElement,
    label: HTMLElement,
    options: { name: string; label: string; numeric?: boolean },
  ) {
    this.numeric = options.numeric ?? false;
    this.mode = new ExpressionMode({
      name: options.name,
      label: options.label,
      seed: () => this.numeric ? this.select.value : choiceLiteral(this.select.value),
      describe: value => describeOption(this.mode.text, value, this.options(), this.key(value)),
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.onChange?.();
    this.mode.onSubmit = () => this.onSubmit?.();
    withExpressionToggle(label, this.mode.toggle);
    this.select.after(this.mode.line);
    pinLabel(this.select);
    this.select.addEventListener('change', () => this.onChange?.());
  }

  /** The option the row stands on: the select's, or the one its expression comes to — undefined while that is unknown or no option's. */
  get value(): V | undefined {
    return this.mode.on ? this.resolved() : this.select.value as V;
  }

  /** The mode is on: the row holds an expression. */
  get on(): boolean {
    return this.mode.on;
  }

  /** What the row writes: the select's option, or the expression. */
  read(): { value: V | FeatureExprValue } | { error: string } {
    return this.mode.on ? this.mode.read() : { value: this.select.value as V };
  }

  /** Programmatic value (a seed, a reset); no change fires. An expression opens the mode, the select underneath on what it comes to. */
  setValue(value: V | FeatureExprValue): void {
    if (ExpressionMode.isExpr(value)) {
      this.mode.show(value.expr);
      this.select.classList.add('hidden');
      const resolved = this.resolved();
      if (resolved !== undefined) {
        this.select.value = resolved;
      }
      return;
    }
    this.mode.clear();
    this.select.classList.remove('hidden');
    this.select.value = value;
  }

  /** The variables the expression completes and resolves over. */
  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
  }

  destroy(): void {
    this.mode.destroy();
  }

  /** The select's options as the mode names them, read live — a panel may relist them. */
  private options(): OptionLabel<V>[] {
    return [...this.select.options].map(option => ({ value: option.value as V, label: option.textContent ?? option.value }));
  }

  /** The option the expression comes to, when it comes to one. */
  private resolved(): V | undefined {
    return resolvedOption(this.key(this.mode.value()), this.options());
  }

  /** A literal as an option's value spells it: a number's digits when the options stand for numbers. */
  private key(value: VariableLiteral | undefined): VariableLiteral | undefined {
    return this.numeric && typeof value === 'number' ? String(value) : value;
  }

  /** The select gives way to the expression, and takes its place again on the option the expression comes to, when it comes to one. */
  private toggleMode(on: boolean): void {
    if (!on) {
      const resolved = this.resolved();
      if (resolved !== undefined) {
        this.select.value = resolved;
      }
    }
    this.select.classList.toggle('hidden', on);
  }
}

/**
 * A built-in dialog's tab row ({@link ChoiceTabs}) with the ƒ mode beside
 * it — a plane's rotation axes, a text's alignment. The tabs' host gives
 * way to the expression line the same way a select does; the row reads the
 * current tab's key, or `{ expr }` while the mode is on.
 */
export class TabsControl<V extends string> {
  /** The user chose a tab or changed the expression; never fired by the setters. */
  onChange?: () => void;
  /** Enter in the expression input. */
  onSubmit?: () => void;

  readonly mode: ExpressionMode;

  constructor(
    private readonly tabs: { value: V; setValue(value: V): void; onChange?: () => void },
    private readonly host: HTMLElement,
    label: HTMLElement,
    private readonly choices: readonly OptionLabel<V>[],
    options: { name: string; label: string },
  ) {
    this.mode = new ExpressionMode({
      name: options.name,
      label: options.label,
      seed: () => choiceLiteral(this.tabs.value),
      describe: value => describeOption(this.mode.text, value, this.choices),
      onToggle: on => this.toggleMode(on),
    });
    this.mode.onChange = () => this.onChange?.();
    this.mode.onSubmit = () => this.onSubmit?.();
    withExpressionToggle(label, this.mode.toggle);
    this.host.after(this.mode.line);
    this.tabs.onChange = () => this.onChange?.();
  }

  /** The tab the row stands on: the current one, or the one its expression comes to — undefined while that is unknown or no tab's. */
  get value(): V | undefined {
    return this.mode.on ? resolvedOption(this.mode.value(), this.choices) : this.tabs.value;
  }

  /** The mode is on: the row holds an expression. */
  get on(): boolean {
    return this.mode.on;
  }

  /** What the row writes: the current tab's key, or the expression. */
  read(): { value: V | FeatureExprValue } | { error: string } {
    return this.mode.on ? this.mode.read() : { value: this.tabs.value };
  }

  /** Programmatic value (a seed, a reset); no change fires. An expression opens the mode, the tabs underneath on what it comes to. */
  setValue(value: V | FeatureExprValue): void {
    if (ExpressionMode.isExpr(value)) {
      this.mode.show(value.expr);
      this.host.classList.add('hidden');
      const resolved = resolvedOption(this.mode.value(), this.choices);
      if (resolved !== undefined) {
        this.tabs.setValue(resolved);
      }
      return;
    }
    this.mode.clear();
    this.host.classList.remove('hidden');
    this.tabs.setValue(value);
  }

  /** The variables the expression completes and resolves over. */
  setVariables(variables: VariableInfo[]): void {
    this.mode.setVariables(variables);
  }

  destroy(): void {
    this.mode.destroy();
  }

  private toggleMode(on: boolean): void {
    if (!on) {
      const resolved = resolvedOption(this.mode.value(), this.choices);
      if (resolved !== undefined) {
        this.tabs.setValue(resolved);
      }
    }
    this.host.classList.toggle('hidden', on);
  }
}

/**
 * How an options row shows the literal its expression comes to: the option's
 * label, muted — or the value under a warning when it is no option's. `key`
 * is the literal as an option's value spells it, where the two differ (a
 * numeric select's digits).
 */
function describeOption<V extends string>(
  text: string,
  value: VariableLiteral,
  options: readonly OptionLabel<V>[],
  key: VariableLiteral | undefined = value,
): ExpressionShown {
  const option = typeof key === 'string' ? options.find(each => each.value === key) : undefined;
  return option
    ? { text: option.label }
    : { text: literalText(value), warning: `${text} is ${literalText(value)}, which is not one of the options.` };
}

/** The option value a literal selects, when it is one of them. */
function resolvedOption<V extends string>(value: VariableLiteral | undefined, options: readonly OptionLabel<V>[]): V | undefined {
  return typeof value === 'string' && options.some(option => option.value === value) ? value as V : undefined;
}
