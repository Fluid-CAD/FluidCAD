// Typed-in slots: how a statement's boolean, text, choice or number argument reads back as a literal, a reference or an expression, and how a dialog's value for it is checked and written.

import type { TSNode } from '../code-editor/index.ts';
import { anyValueArg, booleanArgValue, numericArgValue, refArgValue, stringArgValue } from './ast/args.ts';
import { exprShaped, refShaped, validExpr, validRef, type ExprValue, type RefValue, type ValueExpr } from './value-expr.ts';

/** A dialog's yes/no slot: `true` or `false`, or the expression the statement computes it with. */
export type BooleanSlot = boolean | ExprValue;

/** A dialog's text slot: the string a literal denotes, or the expression the statement computes it with. */
export type TextSlot = string | ExprValue;

/**
 * A dialog's choice slot — one of a fixed set of options (`'front'`, 700):
 * the option, a variable named in its place and written bare, or the
 * expression the statement computes it with.
 */
export type ChoiceSlot<T extends string | number = string> = T | RefValue | ExprValue;

/**
 * The one reading and writing of a dialog's typed-in slots, which the
 * built-in parsers and a custom feature's {@link TypedInKinds} share so the
 * two can't drift: an argument reads as its literal when it is one, as a
 * reference when a choice may name a variable, and as `{ expr }` — the text
 * as the statement has it — for anything else, so a statement computing a
 * value (`drill(flag)`, `keep: flag ? 'front' : 'back'`, `` text(`rib-${n}`) ``)
 * opens in its dialog like one that spells it. A dialog sends an expression
 * back as it got it, or types a new one; the write takes the first whatever
 * its text, since the statement already held it, and checks the second as
 * a number row's expression is checked ({@link validExpr}). What a value
 * means — whether a `keep` is one a split takes — is the preview's to say
 * once it has evaluated the text, never the parse's to refuse.
 */
export class ValueSlots {
  /** The most characters a text literal may have, whatever the slot. */
  static readonly TEXT_LIMIT = 2000;

  /**
   * A statement's argument as the expression it is — whatever it is: the
   * dialog shows it, keeps it, and writes it back as it was. Null for what
   * is no argument of its own — a spread — and for text the grammar could
   * not read (`keep: ...sides`), which no dialog should carry.
   */
  static expr(node: TSNode): ExprValue | null {
    return node.type === 'spread_element' || node.hasError ? null : { expr: node.text };
  }

  /** A boolean argument: `true`/`false` as the flag, anything else as its expression. */
  static boolean(node: TSNode): BooleanSlot | null {
    return booleanArgValue(node) ?? ValueSlots.expr(node);
  }

  /** A text argument: a quoted literal as the string it denotes, anything else — a template string included — as its expression. */
  static text(node: TSNode): TextSlot | null {
    return stringArgValue(node) ?? ValueSlots.expr(node);
  }

  /**
   * A choice argument: a string or number literal as the option it is — null
   * when `options` are given and it is none of them, since the control has
   * nothing to show for it — a plain name or member path as the reference it
   * names, anything else as its expression.
   */
  static choice<T extends string | number>(node: TSNode, options?: readonly T[]): ChoiceSlot<T> | null {
    const literal = stringArgValue(node) ?? numericArgValue(node);
    if (literal !== null) {
      return options === undefined || (options as readonly (string | number)[]).includes(literal) ? literal as T : null;
    }
    return refArgValue(node) ?? ValueSlots.expr(node);
  }

  /** A number argument in a slot nothing else competes for: a literal, or any single-argument-safe expression text. */
  static number(node: TSNode): ValueExpr | null {
    return anyValueArg(node);
  }

  /** Whether a dialog's value is an expression's shape, `{ expr: string }` — well formed or not. */
  static isExpr(value: unknown): value is ExprValue {
    return exprShaped(value);
  }

  /** Whether a dialog's value is a reference's shape, `{ ref: string }` — well formed or not. */
  static isRef(value: unknown): value is RefValue {
    return refShaped(value);
  }

  /** The text an expression holds, trimmed, or null for a blank one. */
  static exprText(value: ExprValue): string | null {
    const text = value.expr.trim();
    return text === '' ? null : text;
  }

  /**
   * Whether a request's field is a slot's shape at all — what a route checks
   * before it knows the statement: a literal `kind` accepts, a well-formed
   * reference, or an expression holding text. Whether the text may be
   * written is the transform's to say ({@link validExpr}, with the
   * statement's own expressions kept), and what it comes to the preview's.
   */
  static shaped(value: unknown, kind: (literal: unknown) => boolean): boolean {
    if (exprShaped(value)) {
      return ValueSlots.exprText(value) !== null;
    }
    return refShaped(value) ? validRef(value) : kind(value);
  }

  /**
   * The expressions an edited statement already holds, by their text: every
   * `{ expr }` its parsed reading carries, wherever it sits. A dialog row left
   * alone sends its expression back as read, and the write takes it whatever
   * the text — a template string, an expression over two lines — because it
   * writes nothing the statement did not have.
   */
  static kept(parsed: unknown): ReadonlySet<string> {
    const texts = new Set<string>();
    const walk = (value: unknown): void => {
      if (exprShaped(value)) {
        texts.add(value.expr);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(walk);
      }
    };
    walk(parsed);
    return texts;
  }

  /**
   * Validate an expression slot for writing: the statement's own, kept as it
   * was, or text a statement may carry as one argument (`validExpr`: one
   * line, no comment, one expression).
   */
  static validExpr(value: unknown, kept?: ReadonlySet<string>): value is ExprValue {
    return exprShaped(value) && ((kept?.has(value.expr) ?? false) || validExpr(value));
  }

  /** A boolean slot a dialog may write: a boolean, or an expression under {@link validExpr}. */
  static validBoolean(value: unknown, kept?: ReadonlySet<string>): value is BooleanSlot {
    return typeof value === 'boolean' || ValueSlots.validExpr(value, kept);
  }

  /** A text slot a dialog may write: a string within the limit, or an expression under {@link validExpr}. */
  static validText(value: unknown, kept?: ReadonlySet<string>, limit: number = ValueSlots.TEXT_LIMIT): value is TextSlot {
    return (typeof value === 'string' && value.length <= limit) || ValueSlots.validExpr(value, kept);
  }

  /** A choice slot a dialog may write: one of the options, a well-formed reference, or an expression under {@link validExpr}. */
  static validChoice<T extends string | number>(value: unknown, options: readonly T[], kept?: ReadonlySet<string>): value is ChoiceSlot<T> {
    if (typeof value === 'string' || typeof value === 'number') {
      return (options as readonly (string | number)[]).includes(value);
    }
    return validRef(value) || ValueSlots.validExpr(value, kept);
  }

  /**
   * A slot as the statement writes it: an expression's text bare, a
   * reference's name bare, a literal as `literal` spells it — each feature
   * keeps its own quoting (`'front'`, `"text"`, `700`).
   */
  static source<T extends string | number | boolean>(value: T | RefValue | ExprValue, literal: (value: T) => string): string {
    if (exprShaped(value)) {
      return value.expr.trim();
    }
    if (refShaped(value)) {
      return value.ref;
    }
    return literal(value);
  }

  /** The literal a slot holds, or undefined for a reference or an expression — what a renderer's own defaults compare against. */
  static literal<T extends string | number | boolean>(value: T | RefValue | ExprValue): T | undefined {
    return exprShaped(value) || refShaped(value) ? undefined : value;
  }
}
