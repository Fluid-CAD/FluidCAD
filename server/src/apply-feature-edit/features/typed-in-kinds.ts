// Typed-in kinds: the one table of a custom feature's typed-in types — checked, written, read back, previewed.

import type { LexicalBindings, TSNode } from '../../code-editor/index.ts';
import { anyValueArg, booleanArgValue, numericArgValue, stringArgValue } from '../ast/args.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';
import type { CustomValueSource } from './custom.ts';

/** A typed-in value as a dialog holds it: a number or expression, a boolean, a string. */
export type TypedInValue = ValueExpr | boolean | string;

/** A typed-in value's source: what a statement writes for it. */
export type TypedInSource = Extract<CustomValueSource, { kind: 'value' | 'literal' }>;

/** A typed-in value's declaration, as far as a kind reads it — never its presentation. */
export type TypedInSpec = {
  label: string;
  type: string;
  min?: number;
  max?: number;
  options?: readonly { value: string | number }[];
};

/** One typed-in type: how its values are checked, read back and previewed. */
export type TypedInKind = {
  /** What a value of the kind is, for messages ("is not a plain …"). */
  name: string;
  /** Whether a preview resolves the value as a numeric expression; else it passes as a literal. */
  expression: boolean;
  /** A request's value as the source a statement writes, or why it doesn't fit its declaration. */
  source(spec: TypedInSpec, raw: unknown): TypedInSource | string;
  /** Why a preview's value doesn't fit the kind, or null; options and ranges are the kernel's to check. */
  preview(spec: TypedInSpec, raw: unknown): string | null;
  /**
   * A statement's argument as the dialog's value; null for anything else —
   * a number's slot holding what is provably no number (a selection,
   * `draft(sel)`'s angle) among them.
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

  private static readonly BOOLEAN: TypedInKind = {
    name: 'true or false',
    expression: false,
    source: (spec, raw) => typeof raw === 'boolean' ? { kind: 'literal', value: raw } : `${spec.label} must be true or false`,
    preview: (spec, raw) => typeof raw === 'boolean' ? null : `${spec.label} must be true or false`,
    read: node => booleanArgValue(node),
  };

  private static readonly TEXT: TypedInKind = {
    name: 'string',
    expression: false,
    source: (spec, raw) => typeof raw === 'string' && raw.length <= 2000 ? { kind: 'literal', value: raw } : `${spec.label} must be a string`,
    preview: (spec, raw) => typeof raw === 'string' ? null : `${spec.label} must be text`,
    read: node => stringArgValue(node),
  };

  /**
   * One of the declared options, by its value: a number written as one, a
   * string as a literal. A select and a radio are the one kind — how the
   * options are shown never reaches a statement.
   */
  private static readonly CHOICE: TypedInKind = {
    name: 'string or number',
    expression: false,
    source: (spec, raw) => {
      const option = (spec.options ?? []).find(o => o.value === raw);
      if (!option) {
        return `${spec.label} must be one of ${(spec.options ?? []).map(o => JSON.stringify(o.value)).join(', ')}`;
      }
      return typeof option.value === 'number' ? { kind: 'value', value: option.value } : { kind: 'literal', value: option.value };
    },
    preview: (spec, raw) => typeof raw === 'string' || typeof raw === 'number' ? null : `${spec.label} must be one of its options`,
    read: node => stringArgValue(node) ?? numericArgValue(node),
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

  /** A type's entry, or null for a type the table doesn't hold; a value with no declared type is a number. */
  static of(type: string | undefined): TypedInKind | null {
    const name = type ?? 'number';
    return Object.hasOwn(TypedInKinds.KINDS, name) ? TypedInKinds.KINDS[name] : null;
  }

  /** The refusal of a type with no entry, to follow the value's name: "… is of the type 'colour', which …". */
  static unknown(type: string | undefined): string {
    return `is of the type '${type}', which this version of FluidCAD does not know`;
  }

  /** A typed-in source as the statement writes it: a number or expression as it reads, a string or boolean as a literal. */
  static text(source: TypedInSource): string {
    if (source.kind === 'value') {
      return formatValue(source.value);
    }
    return typeof source.value === 'boolean' ? String(source.value) : TypedInKinds.quote(source.value);
  }

  /** A declared default a statement can write in a left-out value's place, or undefined. */
  static defaultOf(fallback: unknown): number | string | boolean | undefined {
    return typeof fallback === 'number' || typeof fallback === 'string' || typeof fallback === 'boolean' ? fallback : undefined;
  }

  /** A typed-in value's default as the statement writes it, or undefined for a value without one. */
  static defaultText(fallback: number | string | boolean | undefined): string | undefined {
    if (typeof fallback === 'number') {
      return formatValue(fallback);
    }
    if (typeof fallback === 'string') {
      return TypedInKinds.quote(fallback);
    }
    return typeof fallback === 'boolean' ? String(fallback) : undefined;
  }

  /** A string as a single-quoted literal. */
  static quote(text: string): string {
    const escaped = JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
    return `'${escaped}'`;
  }

  /** A number, or an expression that evaluates to one; `whole` refuses a fraction typed as a number. */
  private static number(whole: boolean): TypedInKind {
    return {
      name: 'number or expression',
      expression: true,
      source: (spec, raw) => {
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
      preview: (spec, raw) => TypedInKinds.isPreviewNumber(raw) ? null : `${spec.label} must be a number or an expression`,
      read: (node, bindings) => TypedInKinds.NOT_NUMBERS.has(node.type) || bindings.kindOf(node) === 'other' ? null : anyValueArg(node),
    };
  }

  /** A preview's number: finite, or expression text the value scope resolves. */
  private static isPreviewNumber(raw: unknown): boolean {
    return (typeof raw === 'number' && Number.isFinite(raw)) || (typeof raw === 'string' && raw.trim() !== '');
  }
}
