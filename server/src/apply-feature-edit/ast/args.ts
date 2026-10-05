// Reading call arguments back out of the tree: literals, value expressions, object entries and identifier references.

import { isExpressionText, walkTree, type LexicalBindings, type TSNode } from '../../code-editor/index.ts';
import { enclosingScope } from './nodes.ts';
import type { ValueExpr } from '../value-expr.ts';

/** Numeric literal text of a node, accepting a unary minus. */
export function numericLiteralText(node: TSNode): string | null {
  if (node.type === 'number') {
    return node.text;
  }
  if (node.type === 'unary_expression' && node.text.startsWith('-')
    && node.namedChildren.length === 1 && node.namedChildren[0].type === 'number') {
    return node.text;
  }
  return null;
}

/** Numeric literal value of an argument node, or null when it is anything else. */
export function numericArgValue(node: TSNode): number | null {
  const text = numericLiteralText(node);
  if (text === null) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Node types whose value an operator computes — the "expression" side of a
 * value slot, as opposed to a reference (identifier, call, member access).
 */
const OPERATOR_EXPRESSIONS = new Set([
  'binary_expression', 'unary_expression', 'parenthesized_expression', 'ternary_expression',
]);

/**
 * Read an argument slot that competes with profile/target expressions for
 * its position (extrude distances, the revolve angle): anything that
 * evaluates to a number at the call site, resolved through `bindings` the
 * way JavaScript scoping resolves it — a `param()` or `const` declared in
 * the enclosing part or sketch body reads exactly like a top-level one.
 *
 * The two sides of the competition get opposite defaults. A reference — a
 * bare identifier, a call, a member access — is a value only when it is
 * provably a number (`depth` bound to `param('Depth', 50)`, `inch(1)`,
 * `Math.max(a, b)`): profile variables and selector targets
 * (`e.endFaces()`) are references too, so an undecidable one (an import, a
 * function parameter) stays null and the positional disambiguation keeps
 * reading it as the profile/target. An operator expression (arithmetic,
 * negation, a ternary) is a value unless it provably is not one.
 */
export function numericValueArg(node: TSNode, bindings: LexicalBindings): ValueExpr | null {
  const literal = numericArgValue(node);
  if (literal !== null) {
    return literal;
  }
  const kind = bindings.kindOf(node);
  const isValue = OPERATOR_EXPRESSIONS.has(node.type) ? kind !== 'other' : kind === 'number';
  if (!isValue) {
    return null;
  }
  if (node.type === 'identifier') {
    return node.text;
  }
  return isExpressionText(node.text) ? node.text : null;
}

/**
 * Read an unambiguous numeric slot (draft, thin, wrap thickness, loft
 * magnitudes — nothing else can occupy the position): a numeric literal, or
 * any single-argument-safe expression text.
 */
export function anyValueArg(node: TSNode): ValueExpr | null {
  const literal = numericArgValue(node);
  if (literal !== null) {
    return literal;
  }
  return isExpressionText(node.text) ? node.text : null;
}

/** Boolean literal value of an argument node, or null when it is anything else. */
export function booleanArgValue(node: TSNode): boolean | null {
  if (node.type === 'true') {
    return true;
  }
  if (node.type === 'false') {
    return false;
  }
  return null;
}

/**
 * The runtime value a plain string literal denotes — quotes dropped and JS
 * escape sequences decoded (the dialog edits the value, not the source
 * spelling). Null for anything but a single/double-quoted literal.
 */
export function stringArgValue(node: TSNode): string | null {
  if (node.type !== 'string') {
    return null;
  }
  const raw = node.text;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return null;
  }
  const body = raw.slice(1, -1);
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, esc: string) => {
      switch (esc[0]) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return '\0';
        case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
        case 'u': {
          const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
          return String.fromCodePoint(parseInt(hex, 16));
        }
        default: return esc;
      }
    },
  );
}

/**
 * The recognized entries of a plain object-literal argument, keyed by
 * property name. Null when the node is not an object literal or carries a
 * shape the dialogs can't read back (spreads, shorthand, computed keys).
 */
export function objectLiteralEntries(node: TSNode): Map<string, TSNode> | null {
  if (node.type !== 'object') {
    return null;
  }
  const entries = new Map<string, TSNode>();
  for (const child of node.namedChildren) {
    if (child.type === 'comment') {
      continue;
    }
    if (child.type !== 'pair') {
      return null;
    }
    const key = child.childForFieldName('key');
    const value = child.childForFieldName('value');
    if (!key || !value || (key.type !== 'property_identifier' && key.type !== 'string')) {
      return null;
    }
    const name = key.type === 'string' ? stringArgValue(key) : key.text;
    if (name === null) {
      return null;
    }
    entries.set(name, value);
  }
  return entries;
}

/**
 * Values of an option that may be a plain number/expression or an array of
 * them: `count: 3` reads as `[3]`, `count: [3, n]` as `[3, 'n']`. The slots
 * are unambiguous (object-literal properties), so any safe expression text
 * qualifies. Null when any element can't be read.
 */
export function numericArrayValues(node: TSNode): ValueExpr[] | null {
  if (node.type === 'array') {
    const values: ValueExpr[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'comment') {
        continue;
      }
      const value = anyValueArg(child);
      if (value === null) {
        return null;
      }
      values.push(value);
    }
    return values;
  }
  const value = anyValueArg(node);
  return value === null ? null : [value];
}

/**
 * The call a plain identifier argument is bound to: a `const <name> = <call>`
 * declaration preceding the statement in a scope that encloses it. Null for
 * anything else (inline calls, unresolvable names, non-call initializers);
 * the nearest preceding declaration wins when a name is declared more than
 * once.
 */
export function resolveIdentifierCall(node: TSNode, statementStart: number): TSNode | null {
  if (node.type !== 'identifier') {
    return null;
  }
  let root: TSNode = node;
  while (root.parent) {
    root = root.parent;
  }
  let best: TSNode | null = null;
  for (const candidate of walkTree(root)) {
    if (candidate.type !== 'variable_declarator' || candidate.startIndex >= statementStart) {
      continue;
    }
    const name = candidate.childForFieldName('name');
    const value = candidate.childForFieldName('value');
    if (!name || name.text !== node.text || !value || value.type !== 'call_expression') {
      continue;
    }
    const scope = enclosingScope(candidate);
    if (scope.startIndex > statementStart || scope.endIndex < statementStart) {
      continue;
    }
    if (!best || candidate.startIndex > best.startIndex) {
      best = candidate;
    }
  }
  return best?.childForFieldName('value') ?? null;
}

/**
 * Resolve a repeat/copy/plane input expression to the statement it
 * references. The returned location is the bound call's own start — the
 * source location its scene object reports — so the edit dialog can seed the
 * input as its timeline row.
 */
export function resolveRepeatTargetRef(node: TSNode, statementStart: number): { line: number; column: number } | null {
  const call = resolveIdentifierCall(node, statementStart);
  return call ? { line: call.startPosition.row + 1, column: call.startPosition.column } : null;
}

/**
 * One of a connector's copies read off its variable — `bay.instance(2)`,
 * the slot a plain whole number: the variable and the slot. Null for any
 * other expression.
 */
export function connectorInstanceRead(node: TSNode): { variable: TSNode; slot: number } | null {
  if (node.type !== 'call_expression') {
    return null;
  }
  const fn = node.childForFieldName('function');
  const object = fn?.type === 'member_expression' ? fn.childForFieldName('object') : null;
  const property = fn?.type === 'member_expression' ? fn.childForFieldName('property') : null;
  const args = node.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'comment') ?? [];
  if (object?.type !== 'identifier' || property?.text !== 'instance' || args.length !== 1) {
    return null;
  }
  const slot = numericArgValue(args[0]);
  if (slot === null || !Number.isSafeInteger(slot) || slot < 0) {
    return null;
  }
  return { variable: object, slot };
}
