// A ghost's typed-in slots: a literal as the dialog sent it, a reference or an expression evaluated where the statement sits, each checked by the slot's kind.

import { ValueSlots } from '../../apply-feature-edit/value-slots.ts';
import type { ValueScope } from './value-scope.ts';

/** What a slot comes to for the preview, or why it draws nothing. */
export type SlotResolution<T> = { value: T } | { reason: string };

/**
 * How a built-in ghost route reads the slots a dialog may hold an expression
 * in — a boolean, a text, a choice. The router checks the shape of each
 * before the scope opens ({@link shaped}: a 400, like any malformed field),
 * then resolves it through the request's {@link ValueScope}, the way the
 * custom route resolves a typed-in row: a literal is itself, a reference
 * or an expression is the literal its text evaluates to at the statement's
 * site, and the kind checks what comes out. One the scope can't evaluate
 * (a name with no value here, a call the whitelist refuses) or that comes
 * to the wrong kind draws no ghost, saying so; the dialog stays open on the
 * text as written.
 */
export class GhostSlots {
  constructor(private readonly scope: ValueScope) {}

  /**
   * Whether a body field is a slot's shape at all: a literal `kind` accepts,
   * a reference, or an expression holding text. Blank text is no shape — a
   * dialog never sends one, so it is malformed, not unresolvable.
   */
  static shaped(value: unknown, kind: (literal: unknown) => boolean): boolean {
    return ValueSlots.shaped(value, kind);
  }

  /** A yes/no slot: a boolean, or text that comes to one. */
  boolean(value: unknown, label: string): SlotResolution<boolean> {
    return this.resolve(value, label, literal => typeof literal === 'boolean' ? literal : undefined, 'true or false');
  }

  /** A text slot: a string, or text that comes to one. */
  text(value: unknown, label: string): SlotResolution<string> {
    return this.resolve(value, label, literal => typeof literal === 'string' ? literal : undefined, 'text');
  }

  /** A choice slot: one of `options`, or text that comes to one. */
  choice<T extends string | number>(value: unknown, options: readonly T[], label: string): SlotResolution<T> {
    const offered = options as readonly (string | number)[];
    return this.resolve(
      value,
      label,
      literal => (typeof literal === 'string' || typeof literal === 'number') && offered.includes(literal) ? literal as T : undefined,
      `one of ${options.map(option => JSON.stringify(option)).join(', ')}`,
    );
  }

  /**
   * The slot's literal: the value itself when it is one `fit` takes; else
   * the reference's or expression's text evaluated here, and `fit` applied
   * to what it comes to.
   */
  private resolve<T>(value: unknown, label: string, fit: (literal: unknown) => T | undefined, expected: string): SlotResolution<T> {
    const named = ValueSlots.isRef(value);
    if (!named && !ValueSlots.isExpr(value)) {
      const literal = fit(value);
      return literal === undefined ? { reason: `${label} must be ${expected}` } : { value: literal };
    }
    const text = named ? value.ref : ValueSlots.exprText(value) ?? '';
    const resolved = this.scope.literal(text);
    if (resolved === null) {
      return {
        reason: named
          ? `${label} names ${text}, which has no value here`
          : `${label} is ${text}, which the preview cannot work out here`,
      };
    }
    const literal = fit(resolved);
    return literal === undefined
      ? { reason: `${label} ${named ? 'names' : 'is'} ${text}, which comes to ${JSON.stringify(resolved)} — not ${expected}` }
      : { value: literal };
  }
}
