// A chained option that takes one word of a fixed set — `.mode('normal')`, `.keep('all')`: its chain, its read-back and its request check.

import { choiceArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';

/**
 * A chained option whose value is one word of a fixed set, the first the
 * default, which a statement leaves out: how the chain is written, read
 * back, and read off a dialog's request, in one wording for every tool.
 */
export class WordOption<T extends string> {
  /** `name` is the chained method's; `words` the values it takes, the default first. */
  constructor(readonly name: string, readonly words: readonly T[]) {}

  /** Whether `value` is one of the words. */
  has(value: unknown): value is T {
    return (this.words as readonly unknown[]).includes(value);
  }

  /** The chain a statement writes for `value`: nothing at the default, else `.<name>('<value>')`. */
  chain(value: T): string {
    return value === this.words[0] ? '' : `.${this.name}('${value}')`;
  }

  /**
   * Reads the chain back: the default when the statement leaves it out, the
   * word when its argument is a string literal spelling one. Anything else —
   * another word, a variable, an expression — has no choice the dialog can
   * show, so the statement is refused.
   */
  read(segment: ChainSegment | undefined): { value: T } | { error: string } {
    if (!segment) {
      return { value: this.words[0] };
    }
    const value = segment.args.length === 1 ? choiceArgValue(segment.args[0], this.words) : null;
    if (value === null) {
      const words = this.words.map(word => `'${word}'`).join(' or ');
      return { error: `the .${this.name}() argument is not ${words} — edit it in the source` };
    }
    return { value };
  }

  /** A create request's field: absent (undefined or null) reads as the default; anything else must be one of the words. */
  fromRequest(raw: unknown): { value: T } | { error: string } {
    const read = this.requested(raw);
    return 'error' in read ? read : { value: read.value ?? this.words[0] };
  }

  /** An edit request's field: absent (undefined or null) keeps the statement's own, read as undefined; anything else must be one of the words. */
  editFromRequest(raw: unknown): { value: T | undefined } | { error: string } {
    return this.requested(raw);
  }

  private requested(raw: unknown): { value: T | undefined } | { error: string } {
    if (raw === undefined || raw === null) {
      return { value: undefined };
    }
    return this.has(raw)
      ? { value: raw }
      : { error: `${this.name} must be ${this.words.map(word => `"${word}"`).join(' or ')}` };
  }
}
