// Reading call arguments back out of the tree: literals, value expressions, object entries and identifier references.

import { isExpressionText, walkTree, type TSNode, type TSTree } from '../../code-editor/index.ts';
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
 * Read an argument slot that competes with profile/target expressions for
 * its position (extrude distances, the revolve angle): a numeric literal, a
 * variable known to hold a number, or arithmetic. Bare identifiers NOT known
 * to be numeric (profile variables) and call expressions (selector targets)
 * stay null so the positional disambiguation keeps working.
 */
export function numericValueArg(node: TSNode, numericVars: Set<string>): ValueExpr | null {
  const literal = numericArgValue(node);
  if (literal !== null) {
    return literal;
  }
  if (node.type === 'identifier') {
    return numericVars.has(node.text) ? node.text : null;
  }
  if (node.type === 'binary_expression' || node.type === 'unary_expression'
    || node.type === 'parenthesized_expression') {
    return isExpressionText(node.text) ? node.text : null;
  }
  return null;
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

/**
 * Top-level variable names whose initializers read as numeric values —
 * literals, arithmetic (over earlier such variables), `param()` and `Math.*`
 * calls. Backs {@link numericValueArg}'s identifier disambiguation.
 */
export function numericVarNames(tree: TSTree): Set<string> {
  const names = new Set<string>();
  const isNumericInit = (node: TSNode): boolean => {
    if (numericLiteralText(node) !== null) {
      return true;
    }
    if (node.type === 'binary_expression' || node.type === 'unary_expression'
      || node.type === 'parenthesized_expression') {
      return true;
    }
    if (node.type === 'identifier') {
      return names.has(node.text);
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (!fn) {
        return false;
      }
      if (fn.type === 'identifier' && fn.text === 'param') {
        return true;
      }
      return fn.type === 'member_expression' && fn.childForFieldName('object')?.text === 'Math';
    }
    return false;
  };
  for (const statement of tree.rootNode.namedChildren) {
    const decl = statement.type === 'export_statement'
      ? statement.namedChildren.find(c => c.type === 'lexical_declaration' || c.type === 'variable_declaration')
      : statement;
    if (!decl || (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration')) {
      continue;
    }
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (name?.type === 'identifier' && value && isNumericInit(value)) {
        names.add(name.text);
      }
    }
  }
  return names;
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
