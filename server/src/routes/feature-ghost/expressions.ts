// Resolving expression text against the document's numeric parameters.

import type { TSNode, TSTree } from '../../code-editor/index.ts';
import type { ValueExpr } from './values.ts';

/** A bare JS identifier — the expression form that resolves without a parse. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Everything an arithmetic dimension can be made of — including the comma a
 * `Math.hypot(a, b)` call needs. A cheap gate before the parser: a quote or a
 * bracket means the text is something other than arithmetic over parameters,
 * and nothing else here needs to look at it.
 */
const ARITHMETIC = /^[A-Za-z0-9_$.\s+\-*/%(),]+$/;

/** Just enough of the shared tree-sitter parser to read one expression. */
type ExpressionParser = { parse(code: string): TSTree };

/**
 * Resolve a dialog value to the number the kernel needs. A number passes
 * through; a name resolves against the file's top-level numeric params,
 * exactly as apply-feature's synthesis links dimensions; and arithmetic over
 * those names is worked out here — `{ count: sides, offset: 360 / sides }` is
 * how a parametric model is actually written, and refusing it left those
 * dialogs with no ghost at all.
 *
 * Parsing goes through the server's own JavaScript grammar rather than a
 * hand-rolled one, and only arithmetic survives {@link evaluateArithmetic}: a
 * name that isn't a param, a call, anything with a side effect resolves to
 * null and the dialog simply shows no ghost.
 */
export function resolveExpr(
  value: ValueExpr,
  params: Map<string, number>,
  parser: ExpressionParser,
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = value.trim();
  if (IDENTIFIER.test(text)) {
    // The common case — a bare name, no parse needed.
    const resolved = params.get(text);
    return resolved !== undefined && Number.isFinite(resolved) ? resolved : null;
  }
  if (!ARITHMETIC.test(text)) {
    return null;
  }
  const statements = parser.parse(text).rootNode.namedChildren;
  if (statements.length !== 1 || statements[0].type !== 'expression_statement') {
    return null;
  }
  const expression = statements[0].namedChild(0);
  const result = expression ? evaluateArithmetic(expression, params) : null;
  return result !== null && Number.isFinite(result) ? result : null;
}

/**
 * The `Math` member a node names — `Math.PI`, `Math.hypot` — or null for any
 * other member access. Own properties only: everything on `Math` itself is a
 * pure numeric constant or function, which is exactly the safety line
 * {@link evaluateArithmetic} holds; inherited names (`constructor`,
 * `toString`) are not.
 */
function mathMember(node: TSNode): string | null {
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

/**
 * An arithmetic expression's value, or null the moment it stops being
 * arithmetic. Seven node types survive — a number, a parameter name, a
 * parenthesized group, the unary and binary operators, and `Math`'s own
 * constants and (pure) functions — so any other call, member access, or an
 * assignment resolves to nothing rather than running: this reads text a
 * dialog typed, and it must not be able to *do* anything.
 */
function evaluateArithmetic(node: TSNode, params: Map<string, number>): number | null {
  if (node.type === 'member_expression') {
    const property = mathMember(node);
    const value = property === null ? undefined : Math[property as keyof Math];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    const property = fn ? mathMember(fn) : null;
    const impl = property === null ? undefined : Math[property as keyof Math];
    if (typeof impl !== 'function') {
      return null;
    }
    const values: number[] = [];
    for (const argument of node.childForFieldName('arguments')?.namedChildren ?? []) {
      if (argument.type === 'comment') {
        continue;
      }
      const value = evaluateArithmetic(argument, params);
      if (value === null) {
        return null;
      }
      values.push(value);
    }
    const result = (impl as (...args: number[]) => number)(...values);
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  }
  if (node.type === 'number') {
    const value = Number(node.text);
    return Number.isFinite(value) ? value : null;
  }
  if (node.type === 'identifier') {
    const value = params.get(node.text);
    return value !== undefined && Number.isFinite(value) ? value : null;
  }
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChild(0);
    return inner ? evaluateArithmetic(inner, params) : null;
  }
  if (node.type === 'unary_expression') {
    const argument = node.childForFieldName('argument');
    const value = argument ? evaluateArithmetic(argument, params) : null;
    if (value === null) {
      return null;
    }
    const operator = node.childForFieldName('operator')?.text;
    return operator === '-' ? -value : operator === '+' ? value : null;
  }
  if (node.type !== 'binary_expression') {
    return null;
  }
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const a = left ? evaluateArithmetic(left, params) : null;
  const b = right ? evaluateArithmetic(right, params) : null;
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
 * Fold the file's derived top-level constants into the params map:
 * `extractNumericParams` reads only literal and `param()` initializers, but a
 * real model derives its dimensions — `const holeX = plateW / 2 - edgeOff` —
 * and a dialog holding `2 * holeX` deserves a ghost as much as one holding a
 * literal. Declarations are walked in file order so chains resolve, each
 * initializer through {@link evaluateArithmetic}'s whitelist (arithmetic and
 * `Math.*` only — nothing here runs the model). A name the map already holds
 * keeps its value: those are the literals and the registry-resolved,
 * override-aware `param()`s, which the file's source default must not undo.
 * An initializer the whitelist refuses (a feature call, a callback) is simply
 * skipped — those names were never dimension material.
 */
export function augmentDerivedParams(tree: TSTree, params: Map<string, number>): void {
  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
      continue;
    }
    for (const declarator of statement.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (!name || name.type !== 'identifier' || !value || params.has(name.text)) {
        continue;
      }
      const resolved = evaluateArithmetic(value, params);
      if (resolved !== null) {
        params.set(name.text, resolved);
      }
    }
  }
}
