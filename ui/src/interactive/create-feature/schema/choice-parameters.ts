import type { FeatureChoiceOption, FeatureRefValue, NewVariable } from '../../../api';
import type { ParameterChip, ParameterChoice } from '../../../ui/controls';
import {
  choiceLiteral, choiceParamInitializer, isValidNewIdentifier, matchRank, ParamDeclareMode, suggestionChip,
  type VariableInfo, type VariableLiteral,
} from '../../../ui/expression-core';

/** A choice's value: its option's. */
type ChoiceValue = string | number;

/**
 * What the variable a choice row names resolves to, against the row's
 * options: the option (of one) or options (of a list) its value selects;
 * a value no option carries; or nothing known — no such variable, or one
 * whose value the file does not spell (`width / 2`, an import).
 */
export type ChoiceResolution =
  | { kind: 'options'; values: ChoiceValue[]; labels: string[] }
  | { kind: 'mismatch'; value: VariableLiteral }
  | { kind: 'unknown' };

/**
 * The parameters a choice row offers in place of its options, and what one it
 * names stands for. Fed the variables in scope as the dialog gets them, it
 * lists the compatible ones for the popover's Parameters group — string
 * options take string values, numeric options numbers, a select of several a
 * list — resolves a name to the option its value selects, and builds the
 * declaration the "New" offer writes. A parameter the row declared itself is
 * resolved from its own literal until the file carries it.
 */
export class ChoiceParameters {
  /** The variables in scope, as the dialog last received them. */
  variables: VariableInfo[] = [];
  /** A parameter the row declared over an option, not yet in the file: resolved from what it was declared over. */
  private declared: { name: string; value: ChoiceValue | ChoiceValue[]; chip: ParameterChip } | null = null;
  /** What the row showed when the popover last listed: what the offer to declare declares over. */
  private seed: ChoiceValue | ChoiceValue[] | undefined;

  constructor(
    /** The row's label, for the messages. */
    private readonly label: string,
    /** The row's declared options, as they stand (narrowing included). */
    private readonly options: () => readonly FeatureChoiceOption[],
    /** The row holds a list: a parameter's value has to be one. */
    private readonly multiple: boolean,
  ) {}

  /** Whether a row's value is a reference's shape, `{ ref: string }`. */
  static isRef(value: unknown): value is FeatureRefValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { ref?: unknown }).ref === 'string';
  }

  /**
   * The rows the popover lists for `query` (the search box's text, trimmed):
   * every compatible variable whose name or project label matches, best
   * match first — plus, once a name is typed, any variable of that name
   * whose value the file does not spell (it may well fit; nothing shows what
   * it selects) — and, when the typed text is a fresh valid name no option
   * matched, the offer to declare a parameter of it over `seed`, the option
   * the row shows. The offer's chip follows the session's P toggle.
   */
  suggest(query: string, optionsMatched: number, seed: ChoiceValue | ChoiceValue[] | undefined): ParameterChoice[] {
    this.seed = seed;
    const lower = query.toLowerCase();
    const listed = this.variables.filter(variable => {
      if (this.fits(variable.value)) {
        return ChoiceParameters.named(variable, lower);
      }
      return lower !== '' && variable.value === undefined && variable.name.toLowerCase().includes(lower);
    });
    listed.sort((a, b) => matchRank(a.name, lower) - matchRank(b.name, lower));
    const rows = listed.map(variable => this.row(variable));
    if (this.offersNew(query, optionsMatched, seed)) {
      rows.push({
        name: query,
        chip: suggestionChip({ name: query, isNew: true }, ParamDeclareMode.enabled),
        isNew: true,
        value: this.labels(seed!),
      });
    }
    return rows;
  }

  /** The variable's name or its project label carries the query. */
  private static named(variable: VariableInfo, lower: string): boolean {
    return variable.name.toLowerCase().includes(lower) || (variable.global?.label.toLowerCase().includes(lower) ?? false);
  }

  /** A fresh valid name, matching no option and no variable, over an option to declare it on. */
  private offersNew(query: string, optionsMatched: number, seed: ChoiceValue | ChoiceValue[] | undefined): boolean {
    if (optionsMatched > 0 || seed === undefined || !isValidNewIdentifier(query)) {
      return false;
    }
    return !this.variables.some(variable => variable.name === query) && this.declared?.name !== query;
  }

  /** A variable's row: its chip, name and label, and the option its value selects. */
  private row(variable: VariableInfo): ParameterChoice {
    return {
      name: variable.name,
      chip: suggestionChip(variable, false),
      ...(variable.global ? { label: variable.global.label, labelTitle: variable.global.file } : {}),
      ...this.shown(variable.name, this.resolve(variable.name)),
    };
  }

  /** What the row or the bound trigger shows for `ref`: the chip of the variable it names (a fresh parameter's own), and what it selects. */
  binding(ref: string): ParameterChoice {
    if (this.declared?.name === ref) {
      return { name: ref, chip: this.declared.chip, ...this.shown(ref, this.resolve(ref)) };
    }
    const variable = this.variables.find(each => each.name === ref);
    if (variable) {
      return this.row(variable);
    }
    // A name the scope doesn't list (yet): the chip of a plain variable, nothing resolved.
    return { name: ref, chip: suggestionChip({ name: ref, initializer: '' }, false) };
  }

  /** The muted text beside a name: the selected option's label, or the raw value under a warning. */
  private shown(ref: string, resolution: ChoiceResolution): Pick<ParameterChoice, 'value' | 'warning'> {
    if (resolution.kind === 'options') {
      return { value: this.joined(resolution.labels) };
    }
    if (resolution.kind === 'mismatch') {
      return { value: choiceLiteral(resolution.value as ChoiceValue | ChoiceValue[]), warning: this.mismatch(ref, resolution.value) };
    }
    return {};
  }

  private mismatch(ref: string, value: VariableLiteral): string {
    return `${ref} is ${choiceLiteral(value as ChoiceValue | ChoiceValue[])}, which is not one of the options.`;
  }

  /** The option (or options) `ref`'s value selects, a value no option carries, or nothing known. */
  resolve(ref: string): ChoiceResolution {
    const value = this.declared?.name === ref ? this.declared.value : this.variables.find(variable => variable.name === ref)?.value;
    if (value === undefined || typeof value === 'boolean') {
      return { kind: 'unknown' };
    }
    const values = Array.isArray(value) ? value : [value];
    if (this.multiple !== Array.isArray(value)) {
      return { kind: 'mismatch', value };
    }
    const options = values.map(each => this.options().find(option => option.value === each));
    if (options.some(option => option === undefined)) {
      return { kind: 'mismatch', value };
    }
    return { kind: 'options', values, labels: options.map(option => option!.label) };
  }

  /** Why the row can't write `ref`: its value is known and no option carries it. Null when it can. */
  error(ref: string): string | null {
    const resolution = this.resolve(ref);
    return resolution.kind === 'mismatch' ? `${this.label}: ${this.mismatch(ref, resolution.value)}` : null;
  }

  /**
   * Declare a parameter `name` over the option (or list) the row showed when
   * the offer was listed: a `param()` offering the row's options with the P
   * toggle on, the literal alone with it off. The row resolves the name from
   * that option until the file carries the declaration. Null when nothing
   * was shown to declare over (no offer was listed).
   */
  declare(name: string): NewVariable | null {
    const chosen = this.seed;
    if (chosen === undefined) {
      return null;
    }
    this.declared = { name, value: chosen, chip: suggestionChip({ name, isNew: true }, ParamDeclareMode.enabled) };
    const initializer = ParamDeclareMode.enabled ? choiceParamInitializer(name, chosen, this.options()) : choiceLiteral(chosen);
    return { name, initializer };
  }

  /** What the parameter the row declared was declared over; undefined when it declared none. */
  get declaredValue(): ChoiceValue | ChoiceValue[] | undefined {
    return this.declared?.value;
  }

  /** The row let go of the parameter it declared (chose an option, was seeded again). */
  forget(): void {
    this.declared = null;
  }

  /** The labels of the options `chosen` names, joined as the trigger joins them. */
  private labels(chosen: ChoiceValue | ChoiceValue[]): string {
    const values = Array.isArray(chosen) ? chosen : [chosen];
    return this.joined(values.map(value => this.options().find(option => option.value === value)?.label ?? choiceLiteral(value)));
  }

  private joined(labels: string[]): string {
    return labels.length === 0 ? 'None' : labels.join(', ');
  }

  /**
   * Whether a variable's value is one the row could hold: a string where the
   * options are strings, a number where they are numbers, a list of such for
   * a select of several. Booleans and unspelled values never fit.
   */
  private fits(value: VariableLiteral | undefined): boolean {
    if (value === undefined || typeof value === 'boolean') {
      return false;
    }
    if (this.multiple) {
      return Array.isArray(value) && value.every(each => this.typed(each));
    }
    return !Array.isArray(value) && this.typed(value);
  }

  /** Some option carries a value of this type. */
  private typed(value: ChoiceValue): boolean {
    return this.options().some(option => typeof option.value === typeof value);
  }
}
