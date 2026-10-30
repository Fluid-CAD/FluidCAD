// The value a dialog row's expression stands for, worked out over the variables in scope — for showing beside the text, never for writing.

import { unwrapDeclaration, type VariableInfo, type VariableLiteral } from './expression-core';

/** A scalar: every literal but a list, which the operators leave alone. */
type Scalar = number | string | boolean;

/** One parsed piece of an expression — the tree {@link LiteralExpressions} evaluates. */
type Node =
  | { kind: 'literal'; value: Scalar }
  | { kind: 'template'; parts: (string | Node)[] }
  | { kind: 'list'; items: Node[] }
  | { kind: 'name'; name: string }
  | { kind: 'math'; member: string; args: Node[] | null }
  | { kind: 'group'; inner: Node }
  | { kind: 'unary'; operator: string; argument: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; consequence: Node; alternative: Node };

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'template'; parts: string[]; substitutions: boolean[] }
  | { kind: 'name'; name: string }
  | { kind: 'op'; op: string };

/** The operators, longest first so `===` is read before `==` before `=`. */
const OPERATORS = ['===', '!==', '**', '??', '||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', '[', ']', ',', '.'];

/** JavaScript's binary precedence, low to high; `??` sits with `||` and never mixes with it or `&&` unparenthesized. */
const PRECEDENCE: Record<string, number> = {
  '??': 1, '||': 1, '&&': 2,
  '==': 3, '!=': 3, '===': 3, '!==': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '**': 7,
};

/**
 * Thrown inside the parser and the evaluator for anything the whitelist
 * leaves out — caught at the top, where it reads as "no value".
 */
class NoValue extends Error {}

/**
 * The dialog-side twin of the server's expression evaluator: the literal a
 * row's expression resolves to over the variables the scope lists, so a
 * row holding `left ? 'left' : 'right'` can show "Right" muted beside the
 * text, the way a row bound to a variable shows the option it selects. The
 * same whitelist — the literals, names and `<binding>.properties.<name>`
 * paths, parentheses, the arithmetic, comparison and logical operators,
 * the conditional, `Math`'s constants and functions — and the same
 * JavaScript semantics on scalars; a name is its listed value, else its
 * initializer evaluated the same way (`param()` and `property()` wrappers
 * unwrapped), a cycle or an unlisted name being nothing. The server's
 * preview decides what the feature gets; this only says what the dialog
 * can vouch for, and says nothing otherwise.
 */
export class LiteralExpressions {
  /** The most characters one expression may have before the dialog gives up showing a value for it. */
  private static readonly MAX_LENGTH = 2000;

  /** The literal `text` stands for over `variables`, or undefined when the dialog cannot work it out. */
  static evaluate(text: string, variables: readonly VariableInfo[]): VariableLiteral | undefined {
    return new LiteralExpressions(variables).value(text, new Set());
  }

  private constructor(private readonly variables: readonly VariableInfo[]) {}

  private value(text: string, seen: ReadonlySet<string>): VariableLiteral | undefined {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.length > LiteralExpressions.MAX_LENGTH) {
      return undefined;
    }
    try {
      const node = new Parser(tokenize(trimmed)).parse();
      const value = this.evaluateNode(node, seen);
      return typeof value === 'number' && !Number.isFinite(value) ? undefined : value;
    } catch (error) {
      if (error instanceof NoValue) {
        return undefined;
      }
      throw error;
    }
  }

  /** A name's literal: the scope's listed value, else its initializer's, read once along any path. */
  private named(name: string, seen: ReadonlySet<string>): VariableLiteral {
    if (seen.has(name)) {
      throw new NoValue();
    }
    const variable = this.variables.find(each => each.name === name);
    if (!variable) {
      throw new NoValue();
    }
    if (variable.value !== undefined) {
      return variable.value;
    }
    const initializer = variable.initializer?.trim();
    if (!initializer) {
      throw new NoValue();
    }
    const value = this.value(unwrapDeclaration(initializer), new Set(seen).add(name));
    if (value === undefined) {
      throw new NoValue();
    }
    return value;
  }

  private evaluateNode(node: Node, seen: ReadonlySet<string>): VariableLiteral {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'template':
        return node.parts.map(part => {
          if (typeof part === 'string') {
            return part;
          }
          const value = this.evaluateNode(part, seen);
          if (Array.isArray(value)) {
            throw new NoValue();
          }
          return String(value);
        }).join('');
      case 'list':
        return node.items.map(item => {
          const value = this.evaluateNode(item, seen);
          if (typeof value !== 'string' && typeof value !== 'number') {
            throw new NoValue();
          }
          return value;
        });
      case 'name':
        return this.named(node.name, seen);
      case 'math':
        return LiteralExpressions.math(node.member, node.args?.map(arg => this.scalar(arg, seen)) ?? null);
      case 'group':
        return this.evaluateNode(node.inner, seen);
      case 'unary':
        return LiteralExpressions.unary(node.operator, this.scalar(node.argument, seen));
      case 'binary':
        return this.binary(node, seen);
      case 'conditional': {
        const test = this.evaluateNode(node.test, seen);
        return this.evaluateNode(LiteralExpressions.truthy(test) ? node.consequence : node.alternative, seen);
      }
      default:
        throw new NoValue();
    }
  }

  private binary(node: Extract<Node, { kind: 'binary' }>, seen: ReadonlySet<string>): VariableLiteral {
    const { operator } = node;
    if (operator === '&&' || operator === '||' || operator === '??') {
      const left = this.evaluateNode(node.left, seen);
      const decided = operator === '&&' ? !LiteralExpressions.truthy(left) : operator === '||' ? LiteralExpressions.truthy(left) : true;
      return decided ? left : this.evaluateNode(node.right, seen);
    }
    const a = this.scalar(node.left, seen);
    const b = this.scalar(node.right, seen);
    switch (operator) {
      case '+': return (a as number) + (b as number);
      case '-': return (a as number) - (b as number);
      case '*': return (a as number) * (b as number);
      case '/': return (a as number) / (b as number);
      case '%': return (a as number) % (b as number);
      case '**': return (a as number) ** (b as number);
      case '===': return a === b;
      case '!==': return a !== b;
      // eslint-disable-next-line eqeqeq -- the model's own loose equality, on primitives only
      case '==': return a == b;
      // eslint-disable-next-line eqeqeq -- as above
      case '!=': return a != b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: throw new NoValue();
    }
  }

  /** An operand that must be a scalar: a list is none. */
  private scalar(node: Node, seen: ReadonlySet<string>): Scalar {
    const value = this.evaluateNode(node, seen);
    if (Array.isArray(value)) {
      throw new NoValue();
    }
    return value;
  }

  private static unary(operator: string, value: Scalar): Scalar {
    switch (operator) {
      case '-': return -value;
      case '+': return +value;
      case '!': return !value;
      default: throw new NoValue();
    }
  }

  /** `Math`'s own constants and functions, over numbers only — nothing inherited, nothing else. */
  private static math(member: string, args: Scalar[] | null): number {
    if (!Object.prototype.hasOwnProperty.call(Math, member)) {
      throw new NoValue();
    }
    const value = Math[member as keyof Math];
    if (args === null) {
      if (typeof value !== 'number') {
        throw new NoValue();
      }
      return value;
    }
    if (typeof value !== 'function' || args.some(arg => typeof arg !== 'number')) {
      throw new NoValue();
    }
    const result = (value as (...numbers: number[]) => unknown)(...args as number[]);
    if (typeof result !== 'number') {
      throw new NoValue();
    }
    return result;
  }

  /** JavaScript's truthiness: a list, being an object, is always true. */
  private static truthy(value: VariableLiteral): boolean {
    return Array.isArray(value) ? true : Boolean(value);
  }
}

/** One escape sequence's character (`\n`, `\x41`, `\u{1F600}`, `\'`). */
function unescape(sequence: string): string {
  switch (sequence[0]) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    case '0': return '\0';
    case 'x': return String.fromCharCode(parseInt(sequence.slice(1), 16));
    case 'u': {
      const hex = sequence[1] === '{' ? sequence.slice(2, -1) : sequence.slice(1);
      return String.fromCodePoint(parseInt(hex, 16));
    }
    default: return sequence;
  }
}

/**
 * The expression as tokens: numbers, quoted strings (escapes decoded), a
 * template string split into its fragments and the source of each `${…}`,
 * names, and the operators. Anything else is no token.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const number = /^(?:\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/;
  const name = /^[A-Za-z_$][\w$]*/;
  const escape = /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/;
  while (i < text.length) {
    const rest = text.slice(i);
    if (/^\s/.test(rest)) {
      i += 1;
      continue;
    }
    const digits = rest.match(number);
    if (digits) {
      tokens.push({ kind: 'number', value: Number(digits[0].replace(/_/g, '')) });
      i += digits[0].length;
      continue;
    }
    const word = rest.match(name);
    if (word) {
      tokens.push({ kind: 'name', name: word[0] });
      i += word[0].length;
      continue;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= text.length || text[j] === '\n') {
          throw new NoValue();
        }
        if (text[j] === quote) {
          break;
        }
        const escaped = text.slice(j).match(escape);
        if (escaped) {
          value += unescape(escaped[0].slice(1));
          j += escaped[0].length;
        } else {
          value += text[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (quote === '`') {
      const parts: string[] = [];
      const substitutions: boolean[] = [];
      let fragment = '';
      let j = i + 1;
      for (;;) {
        if (j >= text.length) {
          throw new NoValue();
        }
        if (text[j] === '`') {
          break;
        }
        if (text.startsWith('${', j)) {
          parts.push(fragment);
          substitutions.push(false);
          fragment = '';
          // The substitution runs to its matching brace, strings and nested braces skipped.
          const end = substitutionEnd(text, j + 2);
          parts.push(text.slice(j + 2, end));
          substitutions.push(true);
          j = end + 1;
          continue;
        }
        const escaped = text.slice(j).match(escape);
        if (escaped) {
          fragment += unescape(escaped[0].slice(1));
          j += escaped[0].length;
        } else {
          fragment += text[j];
          j += 1;
        }
      }
      parts.push(fragment);
      substitutions.push(false);
      tokens.push({ kind: 'template', parts, substitutions });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find(candidate => rest.startsWith(candidate));
    if (!op) {
      throw new NoValue();
    }
    tokens.push({ kind: 'op', op });
    i += op.length;
  }
  return tokens;
}

/** The index of the `}` closing a `${` whose body starts at `from`, over nested braces, strings and templates. */
function substitutionEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (quote !== null) {
      if (ch === '\\') {
        j += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0) {
        return j;
      }
      depth -= 1;
    }
  }
  throw new NoValue();
}

/** A precedence-climbing parser over the tokens: JavaScript's grammar for the whitelisted forms, and {@link NoValue} for the rest. */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.conditional();
    if (this.pos !== this.tokens.length) {
      throw new NoValue();
    }
    return node;
  }

  private peek(op: string): boolean {
    const token = this.tokens[this.pos];
    return token?.kind === 'op' && token.op === op;
  }

  private take(op: string): boolean {
    if (!this.peek(op)) {
      return false;
    }
    this.pos += 1;
    return true;
  }

  private expect(op: string): void {
    if (!this.take(op)) {
      throw new NoValue();
    }
  }

  private conditional(): Node {
    const test = this.binary(1);
    if (!this.take('?')) {
      return test;
    }
    const consequence = this.conditional();
    this.expect(':');
    return { kind: 'conditional', test, consequence, alternative: this.conditional() };
  }

  /** The binary operators at `minimum` precedence and above; `**` groups to the right, the rest to the left. */
  private binary(minimum: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.tokens[this.pos];
      const precedence = token?.kind === 'op' ? PRECEDENCE[token.op] : undefined;
      if (token?.kind !== 'op' || precedence === undefined || precedence < minimum) {
        return left;
      }
      this.pos += 1;
      // `-2 ** 2` is a syntax error in JavaScript: a sign on the base wants parentheses.
      if (token.op === '**' && left.kind === 'unary') {
        throw new NoValue();
      }
      const right = this.binary(token.op === '**' ? precedence : precedence + 1);
      if (Parser.mixesNullish(token.op, left) || Parser.mixesNullish(token.op, right)) {
        throw new NoValue();
      }
      left = { kind: 'binary', operator: token.op, left, right };
    }
  }

  /** `a ?? b || c` is a syntax error in JavaScript: the two never meet without parentheses. */
  private static mixesNullish(operator: string, operand: Node): boolean {
    if (operand.kind !== 'binary') {
      return false;
    }
    return operator === '??' ? operand.operator === '&&' || operand.operator === '||' : operator === '&&' || operator === '||' ? operand.operator === '??' : false;
  }

  private unary(): Node {
    for (const operator of ['!', '-', '+']) {
      if (this.take(operator)) {
        return { kind: 'unary', operator, argument: this.unary() };
      }
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.tokens[this.pos++];
    if (!token) {
      throw new NoValue();
    }
    switch (token.kind) {
      case 'number':
        return { kind: 'literal', value: token.value };
      case 'string':
        return { kind: 'literal', value: token.value };
      case 'template':
        return {
          kind: 'template',
          parts: token.parts.map((part, index) => token.substitutions[index] ? new Parser(tokenize(part)).parse() : part),
        };
      case 'name':
        return this.named(token.name);
      case 'op':
        if (token.op === '(') {
          const inner = this.conditional();
          this.expect(')');
          return { kind: 'group', inner };
        }
        if (token.op === '[') {
          const items: Node[] = [];
          while (!this.take(']')) {
            if (items.length > 0) {
              this.expect(',');
            }
            items.push(this.conditional());
          }
          return { kind: 'list', items };
        }
        throw new NoValue();
      default:
        throw new NoValue();
    }
  }

  /** A name, `true`/`false`, a dotted path the scope lists as one name (`inst.properties.kind`), or `Math`'s member and its call. */
  private named(first: string): Node {
    if (first === 'true' || first === 'false') {
      return { kind: 'literal', value: first === 'true' };
    }
    const path = [first];
    while (this.take('.')) {
      const token = this.tokens[this.pos++];
      if (token?.kind !== 'name') {
        throw new NoValue();
      }
      path.push(token.name);
    }
    if (first === 'Math' && path.length === 2) {
      if (!this.take('(')) {
        return { kind: 'math', member: path[1], args: null };
      }
      const args: Node[] = [];
      while (!this.take(')')) {
        if (args.length > 0) {
          this.expect(',');
        }
        args.push(this.conditional());
      }
      return { kind: 'math', member: path[1], args };
    }
    return { kind: 'name', name: path.join('.') };
  }
}
