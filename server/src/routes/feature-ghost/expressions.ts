// The expressions a ghost evaluates: values typed into a dialog, and the source initializers their names stand for.

import type { TSNode, TSTree } from '../../code-editor/index.ts';

/** Just enough of the shared tree-sitter parser to read one expression. */
export type ExpressionParser = { parse(code: string): TSTree };

/**
 * What an expression evaluates to: a number, a string, a boolean, or a list
 * of strings and numbers — the value types a custom feature's typed-in
 * values take. Nothing else: an object, a function, a scene object is no
 * value a dialog shows.
 */
export type Literal = number | string | boolean | (string | number)[];

/**
 * What an evaluation can't read off the expression itself: the literal each
 * name stands for, and — for source the model wrote, never dialog text —
 * the calls that evaluate to one.
 */
export type ExpressionNames = {
  /** The literal the identifier `node` stands for where it sits, or null. */
  identifier(node: TSNode): Literal | null;
  /**
   * The literal a call other than `Math`'s evaluates to, or null to refuse
   * it. Absent, every such call is refused.
   */
  call?(node: TSNode): Literal | null;
  /**
   * The literal a member access other than `Math`'s stands for, or null to
   * refuse it — an inserted instance's `<binding>.properties.<name>`.
   * Absent, every such access is refused.
   */
  member?(node: TSNode): Literal | null;
};

/**
 * {@link ExpressionNames} for a consumer that reads numbers only — what the
 * numeric evaluators ({@link Arithmetic}) take. Every number is a literal,
 * so these names serve the general evaluator as they are.
 */
export type ArithmeticNames = {
  identifier(node: TSNode): number | null;
  call?(node: TSNode): number | null;
  member?(node: TSNode): number | null;
};

/** A scalar: every literal but a list, which the operators leave alone. */
type Scalar = number | string | boolean;

/**
 * The ghost's expression evaluator. A fixed set of node types survive — the
 * literals (a number, a string, a template string, `true`, `false`, an
 * array of strings and numbers), a name, a parenthesized group, the
 * arithmetic, comparison and logical operators, the conditional, and
 * `Math`'s own constants and (pure) functions — so any other call, member
 * access, or an assignment resolves to nothing rather than running: this
 * reads text a dialog typed, and it must not be able to *do* anything.
 * What a name stands for, whether a source-level call such as `param()`
 * evaluates, and what a member access such as `drawer.properties.width`
 * reads, is up to the caller's {@link ExpressionNames}.
 *
 * The operators follow JavaScript on scalars — `'a' + 1` is `'a1'`,
 * `'3' * 2` is `6`, `0 || 'x'` is `'x'` — since the preview stands for what
 * the model computes; `&&`, `||`, `??` and `?:` short-circuit, so a branch
 * not taken may name what has no value here. A list takes part in no
 * operator, and a number that comes out infinite or NaN is no value.
 */
export class Expressions {
  /** A bare JS identifier — the expression form that resolves without a parse. */
  private static readonly NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  /** The most characters one expression may have: longer text is no dialog value. */
  private static readonly MAX_LENGTH = 2000;

  /** The logical operators, which never mix `??` with `&&` or `||` unparenthesized — a syntax error in JavaScript. */
  private static readonly LOGICAL = new Set(['&&', '||', '??']);

  /** Whether dialog text is a bare name — the common case, which needs no parse. */
  static isName(text: string): boolean {
    return Expressions.NAME.test(text);
  }

  /**
   * The one expression dialog text holds, parsed through the server's own
   * JavaScript grammar rather than a hand-rolled one — or null when the text
   * is anything other than a single expression: two statements, a
   * declaration, a syntax error the grammar had to recover from.
   */
  static parse(text: string, parser: ExpressionParser): TSNode | null {
    if (text.length > Expressions.MAX_LENGTH || text.trim() === '') {
      return null;
    }
    const root = parser.parse(text).rootNode;
    const statements = root.namedChildren.filter(node => node.type !== 'comment');
    if (root.hasError || statements.length !== 1 || statements[0].type !== 'expression_statement') {
      return null;
    }
    const expression = statements[0].namedChildren.filter(node => node.type !== 'comment');
    return expression.length === 1 ? expression[0] : null;
  }

  /** An expression's value, or null the moment it stops being one the whitelist reads — or a finite one. */
  static evaluate(node: TSNode, names: ExpressionNames): Literal | null {
    const value = Expressions.evaluateNode(node, names);
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }

  private static evaluateNode(node: TSNode, names: ExpressionNames): Literal | null {
    switch (node.type) {
      case 'number':
        // A numeric separator (`1_000`) is no part of the value.
        return Number(node.text.replace(/_/g, ''));
      case 'string':
        return Expressions.stringValue(node);
      case 'template_string':
        return Expressions.templateValue(node, names);
      case 'true':
        return true;
      case 'false':
        return false;
      case 'array':
        return Expressions.listValue(node, names);
      case 'identifier':
        return names.identifier(node);
      case 'parenthesized_expression': {
        const inner = node.namedChildren.filter(child => child.type !== 'comment');
        return inner.length === 1 ? Expressions.evaluate(inner[0], names) : null;
      }
      case 'member_expression': {
        const property = Expressions.mathMember(node);
        if (property === null) {
          return names.member ? names.member(node) : null;
        }
        const value = Math[property as keyof Math];
        return typeof value === 'number' ? value : null;
      }
      case 'call_expression':
        return Expressions.callValue(node, names);
      case 'unary_expression':
        return Expressions.unaryValue(node, names);
      case 'binary_expression':
        return Expressions.binaryValue(node, names);
      case 'ternary_expression':
        return Expressions.ternaryValue(node, names);
      default:
        return null;
    }
  }

  /** A quoted string as the value it denotes: its fragments, escape sequences decoded. */
  private static stringValue(node: TSNode): string | null {
    let text = '';
    for (const child of node.namedChildren) {
      if (child.type === 'string_fragment') {
        text += child.text;
      } else if (child.type === 'escape_sequence') {
        const decoded = Expressions.unescape(child.text);
        if (decoded === null) {
          return null;
        }
        text += decoded;
      } else {
        return null;
      }
    }
    return text;
  }

  /** A template string: its fragments as they are, each `${…}` the text of the scalar it evaluates to. */
  private static templateValue(node: TSNode, names: ExpressionNames): string | null {
    let text = '';
    for (const child of node.namedChildren) {
      if (child.type === 'string_fragment') {
        text += child.text;
      } else if (child.type === 'escape_sequence') {
        const decoded = Expressions.unescape(child.text);
        if (decoded === null) {
          return null;
        }
        text += decoded;
      } else if (child.type === 'template_substitution') {
        const inner = child.namedChildren.filter(each => each.type !== 'comment');
        const value = inner.length === 1 ? Expressions.evaluate(inner[0], names) : null;
        if (value === null || Array.isArray(value)) {
          return null;
        }
        text += String(value);
      } else {
        return null;
      }
    }
    return text;
  }

  /** One escape sequence's character (`\n`, `\x41`, `\u{1F600}`, `\'`), or null for a line continuation. */
  private static unescape(sequence: string): string | null {
    const escaped = sequence.slice(1);
    switch (escaped[0]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return escaped.length === 1 ? '\0' : null;
      case 'x': return String.fromCharCode(parseInt(escaped.slice(1), 16));
      case 'u': {
        const hex = escaped[1] === '{' ? escaped.slice(2, -1) : escaped.slice(1);
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : null;
      }
      case '\n':
      case '\r':
        return null;
      default:
        return escaped;
    }
  }

  /** An array literal's strings and numbers, in order — the one list a value may be; null when any element is anything else. */
  private static listValue(node: TSNode, names: ExpressionNames): (string | number)[] | null {
    const values: (string | number)[] = [];
    for (const element of node.namedChildren) {
      if (element.type === 'comment') {
        continue;
      }
      const value = Expressions.evaluate(element, names);
      if (typeof value !== 'string' && typeof value !== 'number') {
        return null;
      }
      values.push(value);
    }
    return values;
  }

  private static callValue(node: TSNode, names: ExpressionNames): Literal | null {
    const fn = node.childForFieldName('function');
    const property = fn ? Expressions.mathMember(fn) : null;
    const impl = property === null ? undefined : Math[property as keyof Math];
    if (typeof impl !== 'function') {
      return names.call ? names.call(node) : null;
    }
    const values: number[] = [];
    for (const argument of node.childForFieldName('arguments')?.namedChildren ?? []) {
      if (argument.type === 'comment') {
        continue;
      }
      const value = Expressions.evaluate(argument, names);
      if (typeof value !== 'number') {
        return null;
      }
      values.push(value);
    }
    const result = (impl as (...args: number[]) => unknown)(...values);
    return typeof result === 'number' ? result : null;
  }

  private static unaryValue(node: TSNode, names: ExpressionNames): Literal | null {
    const argument = node.childForFieldName('argument');
    const value = argument ? Expressions.scalar(argument, names) : null;
    if (value === null) {
      return null;
    }
    switch (node.childForFieldName('operator')?.text) {
      case '-':
        return -value;
      case '+':
        return +value;
      case '!':
        return !value;
      default:
        return null;
    }
  }

  /**
   * The binary operators over scalars, as JavaScript applies them. The
   * logical ones evaluate their right side only when the left leaves the
   * answer open, and `??` never sits unparenthesized beside `&&` or `||`.
   */
  private static binaryValue(node: TSNode, names: ExpressionNames): Literal | null {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const operator = node.childForFieldName('operator')?.text;
    if (!left || !right || operator === undefined) {
      return null;
    }
    if (Expressions.LOGICAL.has(operator)) {
      if (Expressions.mixesNullish(operator, left) || Expressions.mixesNullish(operator, right)) {
        return null;
      }
      const a = Expressions.evaluate(left, names);
      if (a === null) {
        return null;
      }
      const decided = operator === '&&' ? !Expressions.truthy(a) : operator === '||' ? Expressions.truthy(a) : true;
      // `??` never falls through: a value here is never null or undefined.
      return decided ? a : Expressions.evaluate(right, names);
    }
    const a = Expressions.scalar(left, names);
    const b = a === null ? null : Expressions.scalar(right, names);
    if (a === null || b === null) {
      return null;
    }
    switch (operator) {
      case '+':
        return (a as number) + (b as number);
      case '-':
        return (a as number) - (b as number);
      case '*':
        return (a as number) * (b as number);
      case '/':
        return (a as number) / (b as number);
      case '%':
        return (a as number) % (b as number);
      case '**':
        return (a as number) ** (b as number);
      case '===':
        return a === b;
      case '!==':
        return a !== b;
      case '==':
        // eslint-disable-next-line eqeqeq -- the model's own loose equality, on primitives only
        return a == b;
      case '!=':
        // eslint-disable-next-line eqeqeq -- as above
        return a != b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      default:
        return null;
    }
  }

  /** Whether `operand` of a logical `operator` is the other logical kind unparenthesized — `a ?? b || c`, which JavaScript refuses. */
  private static mixesNullish(operator: string, operand: TSNode): boolean {
    if (operand.type !== 'binary_expression') {
      return false;
    }
    const inner = operand.childForFieldName('operator')?.text ?? '';
    return operator === '??' ? inner === '&&' || inner === '||' : inner === '??';
  }

  private static ternaryValue(node: TSNode, names: ExpressionNames): Literal | null {
    const condition = node.childForFieldName('condition');
    const consequence = node.childForFieldName('consequence');
    const alternative = node.childForFieldName('alternative');
    const test = condition ? Expressions.evaluate(condition, names) : null;
    if (test === null || !consequence || !alternative) {
      return null;
    }
    return Expressions.evaluate(Expressions.truthy(test) ? consequence : alternative, names);
  }

  /** An operand that must be a scalar: a list is none. */
  private static scalar(node: TSNode, names: ExpressionNames): Scalar | null {
    const value = Expressions.evaluate(node, names);
    return Array.isArray(value) ? null : value;
  }

  /** JavaScript's truthiness: a list, being an object, is always true. */
  private static truthy(value: Literal): boolean {
    return Array.isArray(value) ? true : Boolean(value);
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

/**
 * The numeric face of {@link Expressions}, for the consumers that read
 * numbers only — a dimension, a params file's number: the same whitelist,
 * the same operators, and nothing but a finite number at the end of it. A
 * comparison, a string, a list is not a number, however it was reached.
 */
export class Arithmetic {
  /** Whether dialog text is a bare name — the common case, which needs no parse. */
  static isName(text: string): boolean {
    return Expressions.isName(text);
  }

  /** The one expression dialog text holds, or null when it is anything else. */
  static parse(text: string, parser: ExpressionParser): TSNode | null {
    return Expressions.parse(text, parser);
  }

  /** An expression's number, or null the moment it stops being one, or finite. */
  static evaluate(node: TSNode, names: ArithmeticNames): number | null {
    const value = Expressions.evaluate(node, names);
    return typeof value === 'number' ? value : null;
  }
}
