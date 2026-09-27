// The arithmetic a ghost evaluates: dimensions typed into a dialog, and the source initializers their names stand for.

import type { TSNode, TSTree } from '../../code-editor/index.ts';

/** Just enough of the shared tree-sitter parser to read one expression. */
export type ExpressionParser = { parse(code: string): TSTree };

/**
 * What an evaluation can't read off the expression itself: the number each
 * name stands for, and — for source the model wrote, never dialog text —
 * the calls that evaluate to one.
 */
export type ArithmeticNames = {
  /** The number the identifier `node` stands for where it sits, or null. */
  identifier(node: TSNode): number | null;
  /**
   * The number a call other than `Math`'s evaluates to, or null to refuse
   * it. Absent, every such call is refused.
   */
  call?(node: TSNode): number | null;
};

/**
 * The ghost's arithmetic. Seven node types survive — a number, a name, a
 * parenthesized group, the unary and binary operators, and `Math`'s own
 * constants and (pure) functions — so any other call, member access, or an
 * assignment resolves to nothing rather than running: this reads text a
 * dialog typed, and it must not be able to *do* anything. What a name
 * stands for, and whether a source-level call such as `param()` evaluates,
 * is up to the caller's {@link ArithmeticNames}.
 */
export class Arithmetic {
  /** A bare JS identifier — the expression form that resolves without a parse. */
  private static readonly NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  /**
   * Everything an arithmetic dimension can be made of — including the comma
   * a `Math.hypot(a, b)` call needs. A cheap gate before the parser: a quote
   * or a bracket means the text is something other than arithmetic over
   * parameters, and nothing else here needs to look at it.
   */
  private static readonly TEXT = /^[A-Za-z0-9_$.\s+\-*/%(),]+$/;

  /** Whether dialog text is a bare name — the common case, which needs no parse. */
  static isName(text: string): boolean {
    return Arithmetic.NAME.test(text);
  }

  /**
   * The one expression dialog text holds, parsed through the server's own
   * JavaScript grammar rather than a hand-rolled one — or null when the text
   * is anything other than a single arithmetic-looking expression.
   */
  static parse(text: string, parser: ExpressionParser): TSNode | null {
    if (!Arithmetic.TEXT.test(text)) {
      return null;
    }
    const statements = parser.parse(text).rootNode.namedChildren;
    if (statements.length !== 1 || statements[0].type !== 'expression_statement') {
      return null;
    }
    return statements[0].namedChild(0);
  }

  /** An arithmetic expression's value, or null the moment it stops being arithmetic or finite. */
  static evaluate(node: TSNode, names: ArithmeticNames): number | null {
    const value = Arithmetic.evaluateNode(node, names);
    return value !== null && Number.isFinite(value) ? value : null;
  }

  private static evaluateNode(node: TSNode, names: ArithmeticNames): number | null {
    switch (node.type) {
      case 'number':
        // A numeric separator (`1_000`) is no part of the value.
        return Number(node.text.replace(/_/g, ''));
      case 'identifier':
        return names.identifier(node);
      case 'parenthesized_expression': {
        const inner = node.namedChild(0);
        return inner ? Arithmetic.evaluate(inner, names) : null;
      }
      case 'member_expression': {
        const property = Arithmetic.mathMember(node);
        const value = property === null ? undefined : Math[property as keyof Math];
        return typeof value === 'number' ? value : null;
      }
      case 'call_expression':
        return Arithmetic.callValue(node, names);
      case 'unary_expression':
        return Arithmetic.unaryValue(node, names);
      case 'binary_expression':
        return Arithmetic.binaryValue(node, names);
      default:
        return null;
    }
  }

  private static callValue(node: TSNode, names: ArithmeticNames): number | null {
    const fn = node.childForFieldName('function');
    const property = fn ? Arithmetic.mathMember(fn) : null;
    const impl = property === null ? undefined : Math[property as keyof Math];
    if (typeof impl !== 'function') {
      return names.call ? names.call(node) : null;
    }
    const values: number[] = [];
    for (const argument of node.childForFieldName('arguments')?.namedChildren ?? []) {
      if (argument.type === 'comment') {
        continue;
      }
      const value = Arithmetic.evaluate(argument, names);
      if (value === null) {
        return null;
      }
      values.push(value);
    }
    const result = (impl as (...args: number[]) => unknown)(...values);
    return typeof result === 'number' ? result : null;
  }

  private static unaryValue(node: TSNode, names: ArithmeticNames): number | null {
    const argument = node.childForFieldName('argument');
    const value = argument ? Arithmetic.evaluate(argument, names) : null;
    if (value === null) {
      return null;
    }
    const operator = node.childForFieldName('operator')?.text;
    return operator === '-' ? -value : operator === '+' ? value : null;
  }

  private static binaryValue(node: TSNode, names: ArithmeticNames): number | null {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const a = left ? Arithmetic.evaluate(left, names) : null;
    const b = right ? Arithmetic.evaluate(right, names) : null;
    if (a === null || b === null) {
      return null;
    }
    switch (node.childForFieldName('operator')?.text) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? null : a / b;
      case '%':
        return b === 0 ? null : a % b;
      case '**':
        return a ** b;
      default:
        return null;
    }
  }

  /**
   * The `Math` member a node names — `Math.PI`, `Math.hypot` — or null for
   * any other member access. Own properties only: everything on `Math`
   * itself is a pure numeric constant or function, which is exactly the
   * safety line this evaluator holds; inherited names (`constructor`,
   * `toString`) are not.
   */
  private static mathMember(node: TSNode): string | null {
    if (node.type !== 'member_expression') {
      return null;
    }
    const object = node.childForFieldName('object');
    const property = node.childForFieldName('property');
    if (object?.type !== 'identifier' || object.text !== 'Math'
      || property?.type !== 'property_identifier'
      || !Object.prototype.hasOwnProperty.call(Math, property.text)) {
      return null;
    }
    return property.text;
  }
}
