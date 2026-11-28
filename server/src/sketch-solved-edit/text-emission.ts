// Text statements riding a solved emission: what an import of a drawing writes for the drawing's text.

import type { SolvedGeometryEmission, SolvedTextEmission } from './emission-spec.ts';

/** What a text may be written along: a statement that draws one curve. */
const PATH_KINDS = new Set<string>(['line', 'arc', 'circle', 'ellipse', 'eArc', 'bezier', 'spline']);

/**
 * A chain of option calls, each with plain arguments: `.font('Arial').size(5).at([10, 20])`.
 * Nothing nests a call, and a string holds no quote of its own kind.
 */
const CHAIN = /^(?:\.[A-Za-z]+\((?:[^()'"\n]|'[^'\n]*'|"[^"\n]*")*\))*$/;

/**
 * A `text()` statement is no solver geometry: it is written after the
 * constraints, where the derived operations go, and its string and its
 * path are arguments the server puts together — the path is a statement of
 * the same emission, whose name only the server knows.
 */
export class TextEmission {
  /** Why `texts` cannot be written; null when they can. */
  static error(texts: readonly SolvedTextEmission[], geometry: readonly SolvedGeometryEmission[]): string | null {
    for (const text of texts) {
      let literal: unknown;
      try {
        literal = JSON.parse(text.string);
      } catch {
        literal = undefined;
      }
      if (typeof literal !== 'string' || text.string.includes('\n')) {
        return 'a text is written as a string literal';
      }
      if (!CHAIN.test(text.chain)) {
        return 'invalid text options';
      }
      if (text.path !== undefined) {
        if (!Number.isInteger(text.path) || text.path < 0 || text.path >= geometry.length) {
          return `text path ${text.path} is out of range`;
        }
        if (!PATH_KINDS.has(geometry[text.path].kind)) {
          return `a text cannot follow a ${geometry[text.path].kind}`;
        }
        if (text.fix) {
          return 'a text on a path has no anchor to fix';
        }
      }
    }
    return null;
  }

  /** The statement of one text, bound to `name`: `const t1 = text("A", l2).size(5);`. */
  static statement(text: SolvedTextEmission, name: string, geometryNames: readonly string[]): string {
    const path = text.path !== undefined ? `, ${geometryNames[text.path]}` : '';
    return `const ${name} = text(${text.string}${path})${text.chain};`;
  }

  /** The constraint that fixes a text's anchor where it is written. */
  static fix(name: string): string {
    return `fix(${name}.anchor());`;
  }
}
