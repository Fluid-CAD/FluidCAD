// Variables a dialog introduces: declaring them and listing the ones in scope.

import { assemblyBodies, assemblyInsertAnchors } from './assembly.ts';

import { updateDimensionExpression } from './dimensions.ts';
import { ensureSymbolImport } from './imports.ts';
import { RenderedProperties, type PropertySourceCall, type RenderedPropertyValue } from './rendered-properties.ts';
import { indentOf, joinLines, resolveSourceRow, splitLines, type CodeEditResult } from './lines.ts';
import { findEditableCallAt, walkTree } from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';
import {
  bareProperties, declarationImports, declareParamStatementsFor, findEnclosingPart, findPartAt,
  freeIdentifiers, isPartLevelInitializer,
} from './parts.ts';
import { findSketchBody, insertGeometryCall } from './statements.ts';

/**
 * Insert `const name = initializer;` at the top of the sketch arrow-function
 * body. Returns the new code and how many lines were added (for callers that
 * need to re-anchor subsequent sourceLine-based edits).
 */
export async function declareSketchVariable(
  code: string,
  sketchSourceLine: number,
  name: string,
  initializer: string,
): Promise<{ newCode: string; linesAdded: number } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sketchSourceLine);
  if (!call) {
    return null;
  }
  const body = findSketchBody(call);
  if (!body) {
    return null;
  }

  const bodyChildren = body.namedChildren;
  const insertRow = body.startPosition.row + 1;
  let indent: string;
  if (bodyChildren.length > 0) {
    indent = indentOf(lines, bodyChildren[0].startPosition.row);
  } else {
    indent = indentOf(lines, body.startPosition.row) + '  ';
  }

  const newLine = `${indent}const ${name} = ${initializer};`;
  lines.splice(insertRow, 0, newLine);
  return { newCode: joinLines(lines), linesAdded: 1 };
}

export type NewVariableDecl = { name: string; initializer: string };

/**
 * Run an edit that may be preceded by inserting `const name = init;` lines at
 * the top of the sketch body — one per requested variable, in order, so a
 * later initializer may reference an earlier variable. The edit receives the
 * (possibly-mutated) code and the number of lines added by the declarations,
 * so it can re-anchor any sourceLine references inside the body. A `param()`
 * declaration instead lands at the top of the part body the sketch lives in
 * ({@link declareParamStatementsFor}) — inserted (with its import) after the
 * edit, so the edit's sourceLine anchors never shift; a `property()` one
 * binds the part's bare property of that name the same way.
 *
 * Adopt this wrapper for any new code-edit endpoint that should support
 * "declare variables on the same commit."
 */
async function withOptionalVariableDeclaration(
  code: string,
  sketchSourceLine: number,
  newVariable: NewVariableDecl | NewVariableDecl[] | null,
  edit: (code: string, lineShift: number) => Promise<CodeEditResult>,
): Promise<CodeEditResult> {
  const requested = newVariable === null ? [] : [newVariable].flat();
  const params = requested.filter((v) => isPartLevelInitializer(v.initializer));
  const locals = requested.filter((v) => !isPartLevelInitializer(v.initializer));

  // Each declaration is inserted at the top of the body, so reversed input
  // order leaves them in input order.
  let declaredCode = code;
  let lineShift = 0;
  for (const v of [...locals].reverse()) {
    const declared = await declareSketchVariable(declaredCode, sketchSourceLine, v.name, v.initializer);
    if (!declared) {
      return { newCode: code };
    }
    declaredCode = declared.newCode;
    lineShift += declared.linesAdded;
  }

  const result = await edit(declaredCode, lineShift);
  if (params.length === 0) {
    return result;
  }
  const statements = params.map((v) => `const ${v.name} = ${v.initializer};`);
  let withParams = await declareParamStatementsFor(result.newCode, sketchSourceLine, statements);
  for (const symbol of declarationImports(statements)) {
    withParams = await ensureSymbolImport(withParams, symbol);
  }
  return { ...result, newCode: withParams };
}

export function insertGeometryCallWithVariable(
  code: string,
  sketchSourceLine: number,
  statement: string,
  newVariable: NewVariableDecl | NewVariableDecl[] | null,
): Promise<CodeEditResult> {
  return withOptionalVariableDeclaration(code, sketchSourceLine, newVariable,
    (c) => insertGeometryCall(c, sketchSourceLine, statement));
}

export function updateDimensionExpressionWithVariable(
  code: string,
  sourceLine: number,
  expression: string,
  sketchSourceLine: number,
  newVariable: NewVariableDecl | NewVariableDecl[] | null,
  dimensionOffset = 0,
  dimensionCall: string | null = null,
): Promise<CodeEditResult> {
  return withOptionalVariableDeclaration(code, sketchSourceLine, newVariable,
    (c, shift) => updateDimensionExpression(c, sourceLine + shift, expression, dimensionOffset, dimensionCall));
}

/**
 * A name an expression field can offer. `unbound` marks a `property()` the
 * enclosing part publishes without binding a variable — a bare statement,
 * the way the Parameters panel writes one; its initializer is the whole
 * call, and a commit that reads the name declares it over that call, which
 * binds the property (see `bindPropertyInBody`).
 */
export type VariableInfo = { name: string; initializer?: string; numeric?: boolean; unbound?: boolean };

/**
 * Whether an initializer is a plain constant, arithmetic expression,
 * `param()` declaration or `property()` of a numeric value — the kind of
 * value a numeric input can reference. Feature results (`extrude(...)`),
 * objects, arrays, strings, and functions are not. Local identifiers resolve
 * through `numericByName`; unknown names (globals, imports) pass permissively.
 */
function isNumericValueNode(node: TSNode, numericByName: Map<string, boolean>): boolean {
  switch (node.type) {
    case 'number':
      return true;
    case 'identifier':
      return numericByName.get(node.text) ?? true;
    case 'unary_expression':
    case 'binary_expression':
    case 'parenthesized_expression':
    case 'ternary_expression':
      return node.namedChildren.every((c) => isNumericValueNode(c, numericByName));
    case 'member_expression': {
      const obj = node.childForFieldName('object');
      return obj ? isNumericValueNode(obj, numericByName) : false;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'param') {
        return true;
      }
      if (fn?.type === 'identifier' && fn.text === 'property') {
        const value = node.childForFieldName('arguments')?.namedChild(2);
        return value ? isNumericValueNode(value, numericByName) : false;
      }
      const isMathCall = fn?.type === 'member_expression'
        && fn.childForFieldName('object')?.text === 'Math';
      if (!isMathCall) {
        return false;
      }
      const args = node.childForFieldName('arguments');
      return !args || args.namedChildren.every((c) => isNumericValueNode(c, numericByName));
    }
    default:
      return false;
  }
}

export async function extractVariablesInScope(
  code: string,
  sketchSourceLine: number,
  rendered: RenderedProperties = RenderedProperties.none(),
): Promise<VariableInfo[]> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const sketchRow = resolveSourceRow(lines, sketchSourceLine);
  if (sketchRow < 0) {
    return [];
  }
  return collectVariablesInScope(tree, sketchRow, findEditableCallAt(tree, lines, sketchSourceLine), rendered);
}

/**
 * The variables a statement appended at the END of the part at `partLine`
 * (1-based) would see — the create-mode scope of a feature dialog while that
 * part is active: the file's top-level declarations above the part and every
 * declaration of the part's own body, its `param()`s first among them. Empty
 * when no `part()` starts on that line.
 */
export async function extractVariablesInPart(
  code: string,
  partLine: number,
  rendered: RenderedProperties = RenderedProperties.none(),
): Promise<VariableInfo[]> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const part = findPartAt(tree, lines, partLine);
  if ('error' in part) {
    return [];
  }
  return collectVariablesInScope(tree, part.body.endPosition.row, null, rendered);
}

/**
 * Variables visible where the catalog appends an insert in the current
 * assembly — the instances inserted above it included, each with the
 * properties its last render computed (see {@link RenderedProperties}).
 */
export async function extractVariablesInAssembly(
  code: string,
  rendered: RenderedProperties = RenderedProperties.none(),
): Promise<VariableInfo[]> {
  const parser = await getParser();
  const tree = parser.parse(code);
  const bodies = assemblyBodies(tree.rootNode);
  if (bodies.length !== 1) {
    return collectVariablesInScope(tree, tree.rootNode.endPosition.row, null, rendered);
  }
  const body = bodies[0];
  const { lastInsert, returnStmt } = assemblyInsertAnchors(body);
  const row = lastInsert?.endPosition.row ?? returnStmt?.startPosition.row ?? body.endPosition.row;
  return collectVariablesInScope(tree, row, null, rendered);
}

/** How a dropdown shows a property's rendered value: source-shaped, so `480` reads as a number and `'oak'` as text. */
function propertyInitializer(value: RenderedPropertyValue): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/**
 * Declarations visible at `sketchRow` (0-based): the file's top-level ones
 * above it, the `sketchCall` body's own, and those of every block enclosing
 * the row up to the row itself — a part body's `param()`s reach a statement
 * inside that part, and never one in another.
 *
 * A name bound to an `insert()` or `part()` call is no value itself, but
 * the object it holds publishes `property()` values: an instance its
 * part's, a definition its default variant's. Each one the render
 * computed is listed as `<name>.properties.<property>`, the way the model
 * reads it, numeric when the value is a number. A definition's are not
 * offered to a statement inside that definition's own body: reading them
 * there would materialize the part that is being built.
 *
 * The enclosing part's own `property()` declarations are offered by name
 * too, bound or not. A bare one (`property('Label', 'name', value);`, as
 * the panel writes it) is marked `unbound`: the first commit that reads
 * it binds the declaration and moves it up to where the statement can
 * read it, so only one whose value reads names visible at the row — the
 * names that body can supply above the statement — is offered.
 */
function collectVariablesInScope(
  tree: TSTree,
  sketchRow: number,
  sketchCall: TSNode | null,
  rendered: RenderedProperties,
): VariableInfo[] {
  const variables: VariableInfo[] = [];
  const seen = new Set<string>();
  const numericByName = new Map<string, boolean>();

  function addVar(name: string, initializer?: string, valueNode?: TSNode) {
    if (!seen.has(name)) {
      seen.add(name);
      const numeric = valueNode ? isNumericValueNode(valueNode, numericByName) : true;
      numericByName.set(name, numeric);
      variables.push({ name, initializer, numeric });
    }
  }

  function enclosesRow(node: TSNode): boolean {
    return node.startPosition.row <= sketchRow && node.endPosition.row >= sketchRow;
  }

  function addRenderedProperties(name: string, source: PropertySourceCall) {
    if (source.kind === 'part' && enclosesRow(source.call)) {
      return;
    }
    const properties = rendered.of(source);
    if (!properties) {
      return;
    }
    for (const [property, value] of Object.entries(properties)) {
      const dotted = `${name}.properties.${property}`;
      if (!seen.has(dotted)) {
        seen.add(dotted);
        variables.push({ name: dotted, initializer: propertyInitializer(value), numeric: typeof value === 'number' });
      }
    }
  }

  function collectDeclarators(node: TSNode) {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        const valueNode = child.childForFieldName('value');
        if (nameNode && nameNode.type === 'identifier') {
          const init = valueNode ? valueNode.text : undefined;
          addVar(nameNode.text, init, valueNode ?? undefined);
          const source = valueNode ? RenderedProperties.sourceCallOf(valueNode) : null;
          if (source) {
            addRenderedProperties(nameNode.text, source);
          }
        }
      }
    }
  }

  const FLUIDCAD_SOURCES = ['fluidcad', 'fluidcad/core', "'fluidcad'", "'fluidcad/core'", '"fluidcad"', '"fluidcad/core"'];

  for (const node of tree.rootNode.namedChildren) {
    if (node.startPosition.row > sketchRow) {
      break;
    }

    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      if (source && FLUIDCAD_SOURCES.some(s => source.text.includes(s.replace(/['"]/g, '')))) {
        continue;
      }
      for (const child of node.namedChildren) {
        if (child.type === 'import_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'import_specifier' || spec.type === 'identifier') {
              const nameNode = spec.type === 'import_specifier'
                ? spec.childForFieldName('name') || spec.namedChildren[0]
                : spec;
              if (nameNode) {
                addVar(nameNode.text);
              }
            } else if (spec.type === 'named_imports') {
              for (const imp of spec.namedChildren) {
                if (imp.type === 'import_specifier') {
                  const alias = imp.childForFieldName('alias');
                  const nameN = alias || imp.childForFieldName('name') || imp.namedChildren[0];
                  if (nameN) {
                    addVar(nameN.text);
                  }
                }
              }
            }
          }
        }
      }
      continue;
    }

    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      collectDeclarators(node);
      continue;
    }

    if (node.type === 'export_statement') {
      for (const child of node.namedChildren) {
        if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
          collectDeclarators(child);
        }
      }
    }
  }

  if (sketchCall) {
    const body = findSketchBody(sketchCall);
    if (body) {
      for (const stmt of body.namedChildren) {
        if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
          collectDeclarators(stmt);
        }
      }
    }
  }

  // Declarations in enclosing bodies — a statement inside an
  // `assembly('name', () => { … })` callback sees the body's earlier consts
  // (`width`, `depth`) the same way a top-level statement sees the file's.
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'statement_block'
      || node.startPosition.row > sketchRow || node.endPosition.row < sketchRow) {
      continue;
    }
    for (const stmt of node.namedChildren) {
      if (stmt.startPosition.row > sketchRow) {
        break;
      }
      if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
        collectDeclarators(stmt);
      }
    }
  }

  const part = findEnclosingPart(tree, sketchRow);
  for (const bare of part ? bareProperties(part.body) : []) {
    if (seen.has(bare.name) || !bare.value) {
      continue;
    }
    const reads = [...freeIdentifiers(bare.value)];
    if (!reads.every((name) => name === 'Math' || seen.has(name))) {
      continue;
    }
    seen.add(bare.name);
    variables.push({
      name: bare.name,
      initializer: bare.call.text,
      numeric: isNumericValueNode(bare.value, numericByName),
      unbound: true,
    });
  }

  return variables;
}
