// Typed-in kinds: the one table of a custom feature's typed-in types — checked, written, read back, previewed.

import type { LexicalBindings, TSNode } from '../../code-editor/index.ts';
import { anyValueArg, listArgValue, refArgValue } from '../ast/args.ts';
import { formatValue, validExpr, validRef, validValueExpr, type ExprValue, type RefValue, type ValueExpr } from '../value-expr.ts';
import { ValueSlots } from '../value-slots.ts';
import type { CustomValueSource } from './custom.ts';

/**
 * A choice bound to a variable rather than to one of its options: the name
 * the statement writes bare (`size: holeSize`, `size: inst.properties.kind`)
 * — an identifier or a dotted member path, never an expression. The one
 * `RefValue` every dialog slot travels.
 */
export type TypedInRef = RefValue;

/**
 * A value written as a source expression rather than a literal — `left ?
 * 'left' : 'right'`, `count > 4`, a call the dialog cannot read: the text
 * as the statement has it. Every typed-in kind reads one back, so a
 * statement computing a value opens in the dialog like any other; a row
 * left alone writes it back as it was, and one the user typed is checked
 * as a number row's expression is before it is written.
 */
export type TypedInExpr = ExprValue;

/** A typed-in value as a dialog holds it: a number or expression, a boolean, a string, a multi-select's list of option values, a choice's reference, any kind's expression. */
export type TypedInValue = ValueExpr | boolean | string | (string | number)[] | TypedInRef | TypedInExpr;

/** A typed-in value's source: what a statement writes for it. */
export type TypedInSource = Extract<CustomValueSource, { kind: 'value' | 'literal' | 'list' }>;

/** A typed-in value's declaration, as far as a kind reads it — never its presentation. */
export type TypedInSpec = {
  label: string;
  type: string;
  /** A select that holds a list of its options' values; `min` and `max` then count the list. */
  multiple?: boolean;
  min?: number;
  max?: number;
  options?: readonly { value: string | number }[];
  /** A text's most characters. */
  maxLength?: number;
  /** A regular expression a text must match as a whole. */
  pattern?: string;
};

/** One typed-in type: how its values are checked, read back and previewed. */
export type TypedInKind = {
  /** What a value of the kind is, for messages ("is not a plain …"). */
  name: string;
  /** Whether a preview resolves the value as a numeric expression; else it passes as a literal (an expression of its resolved to one). */
  expression: boolean;
  /** A request's value as the source a statement writes, or why it doesn't fit its declaration. */
  source(spec: TypedInSpec, raw: unknown): TypedInSource | string;
  /** Why a preview's value doesn't fit the kind, or null; options and ranges are the kernel's to check. */
  preview(spec: TypedInSpec, raw: unknown): string | null;
  /**
   * A statement's argument as the dialog's value: its literal, a choice's
   * reference, or — for every kind but a number's — the expression as
   * written, each read through {@link ValueSlots} as a built-in dialog's
   * slot is. Null for a number's slot holding what is provably no number (a
   * selection, `draft(sel)`'s angle), and for a spread.
   */
  read(node: TSNode, bindings: LexicalBindings): TypedInValue | null;
};

/**
 * The typed-in types a custom feature declares, one entry each: the route
 * checks a request's value by it, the statement reads its argument back by
 * it, the ghost splits numbers from literals by it. A type with no entry is
 * refused by name wherever it is met — never read as a number.
 */
export class TypedInKinds {

  /** Literals that read as expression text but never evaluate to a number. */
  private static readonly NOT_NUMBERS = new Set([
    'string', 'template_string', 'true', 'false', 'object', 'array', 'arrow_function', 'function_expression', 'regex',
  ]);

  /** The most characters any text may have, whatever it declares. */
  private static readonly TEXT_LIMIT = 2000;

  /** A flag: `true` or `false` as a literal, or an expression that evaluates to one. */
  private static readonly BOOLEAN: TypedInKind = {
    name: 'true or false',
    expression: false,
    source: (spec, raw) => TypedInKinds.isExpr(raw)
      ? TypedInKinds.exprSource(spec, raw)
      : typeof raw === 'boolean' ? { kind: 'literal', value: raw } : `${spec.label} must be true or false`,
    preview: (spec, raw) => TypedInKinds.isExpr(raw)
      ? TypedInKinds.exprPreview(spec, raw)
      : typeof raw === 'boolean' ? null : `${spec.label} must be true or false`,
    read: node => ValueSlots.boolean(node),
  };

  /**
   * A text: a string literal, or an expression that evaluates to one. A
   * reference is refused by name, never written bare — a name is an
   * expression here, which is what the dialog sends.
   */
  private static readonly TEXT: TypedInKind = {
    name: 'string',
    expression: false,
    source: (spec, raw) => TypedInKinds.isRef(raw) ? TypedInKinds.noRef(spec)
      : TypedInKinds.isExpr(raw) ? TypedInKinds.exprSource(spec, raw)
        : TypedInKinds.textSource(spec, raw),
    preview: (spec, raw) => TypedInKinds.isRef(raw) ? TypedInKinds.noRef(spec)
      : TypedInKinds.isExpr(raw) ? TypedInKinds.exprPreview(spec, raw)
        : typeof raw === 'string' ? null : `${spec.label} must be text`,
    read: node => ValueSlots.text(node),
  };

  /**
   * One of the declared options, by its value: a number written as one, a
   * string as a literal — or a reference to a variable, written bare, or an
   * expression that evaluates to one of them. A select and a radio are the
   * one kind — how the options are shown never reaches a statement.
   */
  private static readonly CHOICE: TypedInKind = {
    name: 'string or number',
    expression: false,
    source: (spec, raw) => TypedInKinds.isRef(raw) ? TypedInKinds.refSource(spec, raw)
      : TypedInKinds.isExpr(raw) ? TypedInKinds.exprSource(spec, raw)
        : TypedInKinds.choiceSource(spec, raw),
    preview: (spec, raw) => TypedInKinds.isRef(raw) ? TypedInKinds.refPreview(spec, raw)
      : TypedInKinds.isExpr(raw) ? TypedInKinds.exprPreview(spec, raw)
        : typeof raw === 'string' || typeof raw === 'number' ? null : `${spec.label} must be one of its options`,
    read: node => ValueSlots.choice(node),
  };

  /**
   * A select with `multiple: true`: a list of distinct option values, as
   * many as `min` and `max` allow, written as one array literal — the empty
   * list as `[]`, never left out — or a reference to a list-valued
   * variable, written bare, or an expression that evaluates to a list.
   */
  private static readonly CHOICES: TypedInKind = {
    name: 'list of strings or numbers',
    expression: false,
    source: (spec, raw) => TypedInKinds.isRef(raw) ? TypedInKinds.refSource(spec, raw)
      : TypedInKinds.isExpr(raw) ? TypedInKinds.exprSource(spec, raw)
        : TypedInKinds.listSource(spec, raw),
    preview: (spec, raw) => TypedInKinds.isRef(raw) ? TypedInKinds.refPreview(spec, raw)
      : TypedInKinds.isExpr(raw) ? TypedInKinds.exprPreview(spec, raw)
        : Array.isArray(raw) && raw.every(entry => typeof entry === 'string' || typeof entry === 'number')
          ? null
          : `${spec.label} must be a list of its options`,
    read: node => refArgValue(node) ?? listArgValue(node) ?? ValueSlots.expr(node),
  };

  private static readonly KINDS: Readonly<Record<string, TypedInKind>> = {
    number: TypedInKinds.number(false),
    integer: TypedInKinds.number(true),
    length: TypedInKinds.number(false),
    angle: TypedInKinds.number(false),
    boolean: TypedInKinds.BOOLEAN,
    text: TypedInKinds.TEXT,
    select: TypedInKinds.CHOICE,
    radio: TypedInKinds.CHOICE,
  };

  /**
   * A type's entry, or null for a type the table doesn't hold; a value with
   * no declared type is a number, and a select with `multiple` is the list
   * kind.
   */
  static of(type: string | undefined, multiple?: boolean): TypedInKind | null {
    const name = type ?? 'number';
    if (name === 'select' && multiple === true) {
      return TypedInKinds.CHOICES;
    }
    return Object.hasOwn(TypedInKinds.KINDS, name) ? TypedInKinds.KINDS[name] : null;
  }

  /** The refusal of a type with no entry, to follow the value's name: "… is of the type 'colour', which …". */
  static unknown(type: string | undefined): string {
    return `is of the type '${type}', which this version of FluidCAD does not know`;
  }

  /**
   * A typed-in source as the statement writes it: a number or expression as
   * it reads, a string or boolean as a literal, a list as one array literal
   * — brackets kept around one element, and around none.
   */
  static text(source: TypedInSource): string {
    if (source.kind === 'list') {
      return TypedInKinds.listText(source.values);
    }
    if (source.kind === 'value') {
      return formatValue(source.value);
    }
    return typeof source.value === 'boolean' ? String(source.value) : TypedInKinds.quote(source.value);
  }

  /** A declared default a statement can write in a left-out value's place, or undefined. */
  static defaultOf(fallback: unknown): number | string | boolean | (string | number)[] | undefined {
    if (Array.isArray(fallback)) {
      return fallback.every(entry => typeof entry === 'string' || typeof entry === 'number') ? [...fallback] : undefined;
    }
    return typeof fallback === 'number' || typeof fallback === 'string' || typeof fallback === 'boolean' ? fallback : undefined;
  }

  /** A typed-in value's default as the statement writes it, or undefined for a value without one. */
  static defaultText(fallback: number | string | boolean | (string | number)[] | undefined): string | undefined {
    if (Array.isArray(fallback)) {
      return TypedInKinds.listText(fallback);
    }
    if (typeof fallback === 'number') {
      return formatValue(fallback);
    }
    if (typeof fallback === 'string') {
      return TypedInKinds.quote(fallback);
    }
    return typeof fallback === 'boolean' ? String(fallback) : undefined;
  }

  /** Whether a request's value is a reference's shape, `{ ref: string }` — well formed or not. */
  static isRef(value: unknown): value is TypedInRef {
    return ValueSlots.isRef(value);
  }

  /** Whether a request's value is an expression's shape, `{ expr: string }` — well formed or not. */
  static isExpr(value: unknown): value is TypedInExpr {
    return ValueSlots.isExpr(value);
  }

  /** The text an expression holds, trimmed, or null for a blank one. */
  static exprText(value: TypedInExpr): string | null {
    return ValueSlots.exprText(value);
  }

  /**
   * The name a reference holds, when it is one a choice may name — an
   * identifier or a dotted member path (`holeSize`, `inst.properties.kind`),
   * as `validRef` has it — or null for a malformed one (an expression, a
   * call, an index, a blank).
   */
  static refText(value: TypedInRef): string | null {
    return validRef(value) ? value.ref : null;
  }

  /** A string as a single-quoted literal. */
  static quote(text: string): string {
    const escaped = JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
    return `'${escaped}'`;
  }

  /** A list of option values as an array literal: strings single-quoted, numbers bare, `[]` for none. */
  private static listText(values: readonly (string | number)[]): string {
    return `[${values.map(value => typeof value === 'number' ? formatValue(value) : TypedInKinds.quote(value)).join(', ')}]`;
  }

  /**
   * A reference as the source a choice writes — the name bare, like a number
   * row's expression — or why it is no reference a choice takes.
   */
  private static refSource(spec: TypedInSpec, raw: TypedInRef): TypedInSource | string {
    const text = TypedInKinds.refText(raw);
    return text === null ? `${spec.label} must name a variable` : { kind: 'value', value: text };
  }

  /** A preview's reference: fine when well formed (the scope resolves it), refused when not. */
  private static refPreview(spec: TypedInSpec, raw: TypedInRef): string | null {
    return TypedInKinds.refText(raw) === null ? `${spec.label} must name a variable` : null;
  }

  /** The refusal of a reference on a kind that takes none. */
  private static noRef(spec: TypedInSpec): string {
    return `${spec.label} is text, which takes no variable`;
  }

  /**
   * An expression as the source a row writes — the text bare, where a
   * number row's expression goes, under the same checks — or why it is no
   * expression a statement takes.
   */
  private static exprSource(spec: TypedInSpec, raw: TypedInExpr): TypedInSource | string {
    return validExpr(raw)
      ? { kind: 'value', value: raw.expr.trim() }
      : `${spec.label} must be one expression on one line — no comment, no assignment`;
  }

  /** A preview's expression: fine when it holds text (the scope evaluates it, and the kind checks what comes out), refused when blank. */
  private static exprPreview(spec: TypedInSpec, raw: TypedInExpr): string | null {
    return TypedInKinds.exprText(raw) === null ? `${spec.label} must be an expression` : null;
  }

  /** One of the declared options, found by its value: a number written as one, a string as a literal. */
  private static choiceSource(spec: TypedInSpec, raw: unknown): TypedInSource | string {
    const option = (spec.options ?? []).find(o => o.value === raw);
    if (!option) {
      return `${spec.label} must be one of ${(spec.options ?? []).map(o => JSON.stringify(o.value)).join(', ')}`;
    }
    return typeof option.value === 'number' ? { kind: 'value', value: option.value } : { kind: 'literal', value: option.value };
  }

  /** A list of the declared options' values, none twice, within the declaration's `min` and `max` counts. */
  private static listSource(spec: TypedInSpec, raw: unknown): TypedInSource | string {
    const offered = (spec.options ?? []).map(option => option.value);
    if (!Array.isArray(raw) || raw.some(entry => !offered.includes(entry))) {
      return `${spec.label} must be a list of ${offered.map(value => JSON.stringify(value)).join(', ')}`;
    }
    const repeated = raw.find((entry, index) => raw.indexOf(entry) !== index);
    if (repeated !== undefined) {
      return `${spec.label} lists ${JSON.stringify(repeated)} twice`;
    }
    if (spec.min !== undefined && raw.length < spec.min) {
      return `${spec.label} takes at least ${spec.min}`;
    }
    if (spec.max !== undefined && raw.length > spec.max) {
      return `${spec.label} takes at most ${spec.max}`;
    }
    return { kind: 'list', values: [...raw] };
  }

  /** A string within the flat limit, and within its declaration's `maxLength` and `pattern` (matched against the whole of it). */
  private static textSource(spec: TypedInSpec, raw: unknown): TypedInSource | string {
    if (typeof raw !== 'string' || raw.length > TypedInKinds.TEXT_LIMIT) {
      return `${spec.label} must be a string`;
    }
    if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
      return `${spec.label} must be at most ${spec.maxLength} characters`;
    }
    if (spec.pattern !== undefined && !new RegExp(`^(?:${spec.pattern})$`, 'u').test(raw)) {
      return `${spec.label} must match ${spec.pattern}`;
    }
    return { kind: 'literal', value: raw };
  }

  /** A number, or an expression that evaluates to one — bare, or in the expression shape the other kinds travel; `whole` refuses a fraction typed as a number. */
  private static number(whole: boolean): TypedInKind {
    return {
      name: 'number or expression',
      expression: true,
      source: (spec, raw) => {
        if (TypedInKinds.isExpr(raw)) {
          return TypedInKinds.exprSource(spec, raw);
        }
        if (!validValueExpr(raw)) {
          return `${spec.label} must be a number or an expression`;
        }
        if (typeof raw === 'number') {
          if (whole && !Number.isInteger(raw)) {
            return `${spec.label} must be a whole number`;
          }
          if (spec.min !== undefined && raw < spec.min) {
            return `${spec.label} must be at least ${spec.min}`;
          }
          if (spec.max !== undefined && raw > spec.max) {
            return `${spec.label} must be at most ${spec.max}`;
          }
        }
        return { kind: 'value', value: raw };
      },
      preview: (spec, raw) => TypedInKinds.isExpr(raw)
        ? TypedInKinds.exprPreview(spec, raw)
        : TypedInKinds.isPreviewNumber(raw) ? null : `${spec.label} must be a number or an expression`,
      read: (node, bindings) => TypedInKinds.NOT_NUMBERS.has(node.type) || bindings.kindOf(node) === 'other' ? null : anyValueArg(node),
    };
  }

  /** A preview's number: finite, or expression text the value scope resolves. */
  private static isPreviewNumber(raw: unknown): boolean {
    return (typeof raw === 'number' && Number.isFinite(raw)) || (typeof raw === 'string' && raw.trim() !== '');
  }
}
