import type { FeatureExprValue } from '../../api';
import { ParameterRows } from '../../ui/controls';
import type { VariableInfo, VariableLiteral } from '../../ui/expression-core';
import { ExpressionField } from '../../ui/expression-field';
import { LiteralExpressions } from '../../ui/literal-expressions';

/** What a row says of the literal its expression resolves to: the text to show muted, or under a warning when no value of the row's takes it. */
export type ExpressionShown = { text: string; warning?: string };

export interface ExpressionModeOptions {
  /** The value's name, for the controls' `data-role`s. */
  name: string;
  /** The row's label, for the messages. */
  label: string;
  /** The row's own value as source, to start the expression from when the user switches: `'m4'`, `true`, `['deburr']`; empty for none. */
  seed: () => string;
  /** How the row shows a literal the expression resolves to. */
  describe: (value: VariableLiteral) => ExpressionShown;
  /** The mode went on or off by the user's hand: the host shows or hides its own control. */
  onToggle: (on: boolean) => void;
}

const TOGGLE = 'btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono text-[11px] text-base-content/50 aria-pressed:text-primary aria-pressed:bg-primary/10';
const INPUT = 'input input-sm input-bordered w-full text-xs font-mono';

/**
 * A typed-in row's expression mode — what lets a select, a radio, a boolean
 * or a text hold a source expression the way a number row does. The ƒ
 * toggle beside the row's label switches it: on, the row's own control
 * gives way to an expression input (with the variables in scope on its
 * dropdown) and, under it, the value the text resolves to, muted, the way
 * a row bound to a variable shows the option it selects — or a warning
 * when the value is none of the row's; off, the control is back. A
 * statement holding an expression opens the row in this mode, clean; the
 * row reads `{ expr }` while it stays on, and the server writes the text
 * bare, checked as a number row's expression is. The toggle is also the
 * way back: an expression is never a dead end the file alone can undo.
 */
export class ExpressionMode {
  /** The user typed, or left an expression for the control: the row is theirs now. */
  onChange?: () => void;
  /** Enter in the input. */
  onSubmit?: () => void;

  /** The ƒ toggle, for the host's label line. */
  readonly toggle: HTMLButtonElement;
  /** The input and the resolved value under it, for the host's row after its control; hidden while the mode is off. */
  readonly line: HTMLElement;

  private readonly input: HTMLInputElement;
  private readonly field: ExpressionField;
  private readonly note: HTMLElement;
  private variables: VariableInfo[] = [];
  private active = false;
  /** The mode holds an expression of the statement's or the user's: leaving it changes the row. */
  private held = false;

  /** Whether a row's value is an expression's shape, `{ expr: string }`. */
  static isExpr(value: unknown): value is FeatureExprValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { expr?: unknown }).expr === 'string';
  }

  constructor(private readonly options: ExpressionModeOptions) {
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.dataset.role = `expression-${options.name}`;
    this.toggle.className = TOGGLE;
    this.toggle.textContent = 'ƒ';
    this.toggle.setAttribute('aria-pressed', 'false');
    this.toggle.title = 'Write an expression';
    this.toggle.addEventListener('click', () => this.flip());

    this.line = document.createElement('div');
    this.line.dataset.role = `expression-line-${options.name}`;
    this.line.className = 'hidden w-full flex flex-col gap-1';
    this.input = document.createElement('input');
    this.input.dataset.role = `expr-${options.name}`;
    this.input.type = 'text';
    this.input.className = INPUT;
    this.input.placeholder = 'expression';
    this.input.setAttribute('aria-label', `${options.label} expression`);
    this.note = document.createElement('span');
    this.note.dataset.role = 'resolved';
    this.note.className = `${ParameterRows.VALUE_CLASS} text-xs`;
    this.note.hidden = true;
    this.line.append(this.input, this.note);
    // Arithmetic only: the dropdown completes the names in scope and offers no declaration — an expression here declares nothing.
    this.field = new ExpressionField(this.input, { arithmeticOnly: true });
    this.field.onSubmit = () => this.onSubmit?.();
    this.input.addEventListener('input', () => {
      this.held = true;
      this.resolve();
      this.onChange?.();
    });
  }

  /** The mode is on: the row holds an expression. */
  get on(): boolean {
    return this.active;
  }

  /** The expression as typed, trimmed. */
  get text(): string {
    return this.input.value.trim();
  }

  /** Show `text` as the row's expression — a statement's own, a seed's; not the user's. */
  show(text: string): void {
    this.field.setValue(text);
    this.held = true;
    this.set(true);
    this.resolve();
  }

  /** Leave the mode, the control showing again; not the user's. */
  clear(): void {
    if (this.active) {
      this.set(false);
    }
    this.held = false;
  }

  /** The expression to write, or why there is none to. */
  read(): { value: FeatureExprValue } | { error: string } {
    const text = this.text;
    return text === '' ? { error: `${this.options.label} needs an expression.` } : { value: { expr: text } };
  }

  /** The literal the expression resolves to over the variables in scope; undefined when the dialog cannot say. */
  value(): VariableLiteral | undefined {
    return LiteralExpressions.evaluate(this.text, this.variables);
  }

  /** The variables the input completes and the value resolves over; a shown expression resolves again by them. */
  setVariables(variables: VariableInfo[]): void {
    this.variables = variables;
    this.field.setVariables(variables);
    if (this.active) {
      this.resolve();
    }
  }

  destroy(): void {
    this.field.destroy();
  }

  /** The user pressed ƒ: on, over the row's own value as source; off, back to the control — a change when an expression was held. */
  private flip(): void {
    if (this.active) {
      const changed = this.held;
      this.set(false);
      this.held = false;
      this.options.onToggle(false);
      if (changed) {
        this.onChange?.();
      }
      return;
    }
    this.field.setValue(this.options.seed());
    this.held = false;
    this.set(true);
    this.options.onToggle(true);
    this.resolve();
    this.input.focus();
  }

  private set(on: boolean): void {
    this.active = on;
    this.line.classList.toggle('hidden', !on);
    this.toggle.setAttribute('aria-pressed', String(on));
    this.toggle.title = on ? 'Back to choosing a value' : 'Write an expression';
  }

  /** The value the text resolves to now, muted under the input — or the warning the row gives it; nothing while unknown. */
  private resolve(): void {
    const value = this.text === '' ? undefined : this.value();
    const shown = value === undefined ? null : this.options.describe(value);
    this.note.hidden = shown === null;
    this.note.textContent = shown?.text ?? '';
    this.note.className = `${shown?.warning ? ParameterRows.WARNING_CLASS : ParameterRows.VALUE_CLASS} text-xs`;
    this.note.title = shown?.warning ?? '';
  }
}
