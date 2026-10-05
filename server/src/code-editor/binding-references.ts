// The references of one binding — every identifier that reads it, resolved
// through JavaScript's scoping — and the two rewrites a declaration edit
// needs of them: renaming each in place, and replacing each with an
// expression that means the same where it is read.

import { LexicalBindings, type Binding } from './lexical-bindings.ts';
import { isSameNode } from './declaration-calls.ts';
import type { SpliceEdit } from './lines.ts';
import { walkTree } from './nodes.ts';
import { getParser, type TSNode } from './parser.ts';

/**
 * One read of a binding. `shorthand` marks an object-literal shorthand
 * (`{ width }`), which spells the key and the read in one token — a rewrite
 * has to expand it (`{ width: 10 }`) rather than replace it.
 */
export type BindingReference = { node: TSNode; shorthand: boolean };

/** A name an expression reads without declaring it, and the binding it resolves to where it sits. */
export type FreeIdentifier = { name: string; node: TSNode; binding: Binding | null };

/**
 * Whether an identifier token reads a variable. The grammar already gives
 * member properties and object keys their own token type; what is left to
 * exclude are the spots where an `identifier` declares a name or names a
 * module export.
 */
function readsVariable(node: TSNode): boolean {
  if (node.type === 'shorthand_property_identifier') {
    return true;
  }
  if (node.type !== 'identifier') {
    return false;
  }
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  switch (parent.type) {
    case 'import_specifier':
    case 'namespace_import':
    case 'import_clause':
    case 'formal_parameters':
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_expression':
    case 'function':
    case 'generator_function':
    case 'class_declaration':
    case 'class':
    case 'catch_clause':
    case 'labeled_statement':
    case 'break_statement':
    case 'continue_statement':
      return false;
    case 'variable_declarator':
      return !isSameNode(parent.childForFieldName('name'), node);
    case 'export_specifier':
      // `export { local as exported }`: only the local side reads a binding.
      return isSameNode(parent.childForFieldName('name'), node);
    case 'arrow_function':
      // `x => …`: a single unparenthesized parameter.
      return !isSameNode(parent.childForFieldName('parameter'), node);
    case 'for_in_statement':
      return !isSameNode(parent.childForFieldName('left'), node) || parent.childForFieldName('kind') === null;
    default:
      return true;
  }
}

/**
 * Every read of `binding` in the tree, in source order. Resolution follows
 * scoping, so a nested block that redeclares the name hides the binding
 * there, and a read of a same-named parameter is not a read of this one.
 */
export function findBindingReferences(bindings: LexicalBindings, binding: Binding): BindingReference[] {
  const references: BindingReference[] = [];
  for (const node of walkTree(bindings.tree.rootNode)) {
    if (node.text !== binding.name || !readsVariable(node) || isSameNode(node, binding.id)) {
      continue;
    }
    const resolved = bindings.resolve(node.text, node);
    if (resolved && isSameNode(resolved.id, binding.id)) {
      references.push({ node, shorthand: node.type === 'shorthand_property_identifier' });
    }
  }
  return references;
}

/**
 * The binding a `const <name> = …` declarator introduces, from the
 * identifier node that names it — the handle {@link findBindingReferences}
 * takes.
 */
export function bindingOfDeclarator(bindings: LexicalBindings, nameNode: TSNode): Binding | null {
  const binding = bindings.resolve(nameNode.text, nameNode);
  return binding && isSameNode(binding.id, nameNode) ? binding : null;
}

/**
 * The names `expression` reads from outside itself: every identifier read
 * that no declaration inside the expression (an arrow's parameter) owns,
 * with the binding it resolves to at the expression — null for a global
 * such as `Math`. What decides whether the expression can be copied
 * somewhere else and still mean the same.
 */
export function freeIdentifiers(bindings: LexicalBindings, expression: TSNode): FreeIdentifier[] {
  const free: FreeIdentifier[] = [];
  for (const node of walkTree(expression)) {
    if (!readsVariable(node)) {
      continue;
    }
    const binding = bindings.resolve(node.text, node);
    const declaredInside = binding !== null
      && binding.id.startIndex >= expression.startIndex && binding.id.endIndex <= expression.endIndex;
    if (!declaredInside) {
      free.push({ name: node.text, node, binding });
    }
  }
  return free;
}

/**
 * Whether every bound name `free` lists resolves to the same declaration at
 * `site` as it did at the expression — the condition under which the
 * expression, copied to `site`, still reads what it read. A global stays a
 * global anywhere; a name that resolves to nothing at the site, or to a
 * different declaration there (a same-named local), disqualifies it.
 */
export function readsSameBindings(bindings: LexicalBindings, free: FreeIdentifier[], site: TSNode): boolean {
  for (const { name, binding } of free) {
    const there = bindings.resolve(name, site);
    if (binding === null ? there !== null : !(there && isSameNode(there.id, binding.id))) {
      return false;
    }
  }
  return true;
}

/** Parents where an expression of any shape can stand in for a bare identifier without parentheses. */
const SELF_DELIMITING_PARENTS = new Set([
  'arguments', 'array', 'pair', 'variable_declarator', 'parenthesized_expression',
  'expression_statement', 'return_statement', 'template_substitution', 'spread_element',
  'subscript_expression', 'assignment_expression',
]);

/** Expression node types that bind tighter than any operator around them. */
const ATOMIC_TYPES = new Set([
  'number', 'string', 'template_string', 'true', 'false', 'null', 'undefined', 'identifier',
  'member_expression', 'subscript_expression', 'call_expression', 'array', 'object',
  'parenthesized_expression', 'regex', 'this',
]);

/**
 * Whether `text` is one expression that needs no parentheses wherever it
 * lands: a literal, a name, a member or call chain. `2 * wall` and `-5`
 * are not — dropped into `a - width` they would rebind.
 */
export async function isAtomicExpression(text: string): Promise<boolean> {
  const parser = await getParser();
  const tree = parser.parse(text.trim());
  const statements = tree.rootNode.namedChildren.filter((n) => n.type !== 'comment');
  if (statements.length !== 1 || statements[0].type !== 'expression_statement') {
    return false;
  }
  const expression = statements[0].namedChildren.find((n) => n.type !== 'comment');
  return expression !== undefined && ATOMIC_TYPES.has(expression.type);
}

/**
 * `expression` as it reads in place of the identifier at `reference`:
 * parenthesized when it is compound and the surrounding syntax could bind
 * into it, bare where the position delimits it anyway.
 */
export function expressionInPlaceOf(reference: TSNode, expression: string, atomic: boolean): string {
  if (atomic) {
    return expression;
  }
  const parent = reference.parent;
  // In `{ key: value }` only the value side is a delimited slot; in `a[i]`
  // only the index — `(base * 2)[0]` needs its parentheses.
  if (parent?.type === 'pair' && !isSameNode(parent.childForFieldName('value'), reference)) {
    return `(${expression})`;
  }
  if (parent?.type === 'subscript_expression' && !isSameNode(parent.childForFieldName('index'), reference)) {
    return `(${expression})`;
  }
  return parent && SELF_DELIMITING_PARENTS.has(parent.type) ? expression : `(${expression})`;
}

/** The edits that rename every reference — a shorthand becomes `key: newName`. */
export function renameReferenceEdits(references: BindingReference[], newName: string): SpliceEdit[] {
  return references.map(({ node, shorthand }) => ({
    start: node.startIndex,
    end: node.endIndex,
    text: shorthand ? `${node.text}: ${newName}` : newName,
  }));
}

/** The edits that replace every reference by `expression` — a shorthand becomes `key: expression`. */
export function inlineReferenceEdits(references: BindingReference[], expression: string, atomic: boolean): SpliceEdit[] {
  return references.map(({ node, shorthand }) => ({
    start: node.startIndex,
    end: node.endIndex,
    text: shorthand ? `${node.text}: ${expression}` : expressionInPlaceOf(node, expression, atomic),
  }));
}
