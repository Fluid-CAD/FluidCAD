// Where a new statement lands: sketch bodies, part bodies, after the last producer, or at top level.

import {
  chainRootCallee,
  declareParamStatements,
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  isBreakpointStatement,
  spliceCode,
  splitLines,
  type TSNode,
  type TSTree,
} from '../code-editor.ts';
import {
  enclosingScope,
  enclosingStatement,
  FUNCTION_NODE_TYPES,
  LOOP_NODE_TYPES,
  sameNode,
} from './ast/nodes.ts';
import type { ProducerBinding } from './producers/bindings.ts';
import { renderNewVariableDecls } from './render/variable-decls.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec } from './spec.ts';

/**
 * Append a statement that references no existing code (pick-less sketch,
 * standard-base plane) after the file's last statement — before the first
 * `breakpoint();` (a paused build never runs statements after it) or a
 * trailing `return`, matching the file's semicolon style — or as an empty
 * file's first. With `partLoc` (the timeline's active part) the statement
 * lands at the end of that `part()`'s callback body instead, under the same
 * breakpoint/return rules. `statementFor` receives the insertion indent (for
 * multi-line bodies) and renders without the trailing semicolon.
 */
export async function appendTopLevelStatement(
  code: string,
  statementFor: (indent: string) => string,
  callee: string,
  newVariables?: ApplyFeatureEditSpec['newVariables'],
  partLoc?: { line: number; column: number },
): Promise<ApplyFeatureEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const children = tree.rootNode.namedChildren;
  const last = children.length > 0 ? children[children.length - 1] : null;
  const useSemicolon = children.some(c => c.text.trimEnd().endsWith(';'));

  // Declarations a dialog expression field committed land directly before
  // the statement, at its indent.
  const declsResult = renderNewVariableDecls(code, newVariables, useSemicolon);
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  const block = (indent: string) => [...declsResult.decls, `${statementFor(indent)}${useSemicolon ? ';' : ''}`]
    .join(`\n${indent}`);

  let result: string;
  if (partLoc) {
    const target = resolvePartBodyInsertion(partLoc, [], lines, tree);
    if ('error' in target) {
      return { newCode: code, error: target.error };
    }
    result = spliceCode(code, target.index, target.index, target.wrap(block(target.indent)));
  } else if (!last) {
    result = spliceCode(code, code.length, code.length,
      [...declsResult.decls, `${statementFor('')};`].join('\n') + '\n');
  } else {
    const before = children.find(isBreakpointStatement)
      ?? (last.type === 'return_statement' ? last : null);
    const indent = indentOf(lines, (before ?? last).startPosition.row);
    result = before
      ? spliceCode(code, before.startIndex, before.startIndex, `${block(indent)}\n${indent}`)
      : spliceCode(code, last.endIndex, last.endIndex, `\n${indent}${block(indent)}`);
  }
  // A `param()` declaration goes at the top of the part the statement was
  // appended to — the part's line holds through an append inside its body —
  // and after the imports in a file without one.
  const landed = await declareParamStatements(result, partLoc?.line ?? null, declsResult.paramDecls);
  if ('error' in landed) {
    return { newCode: code, error: landed.error };
  }
  result = await ensureSymbolImport(landed.newCode, callee);
  if (declsResult.paramDecls.length > 0) {
    result = await ensureSymbolImport(result, 'param');
  }
  return { newCode: result };
}

/**
 * Where the feature statement goes: at the end of the producers' scope —
 * before an active `breakpoint();` or a trailing `return` — regardless of
 * how the inputs are sourced. End of scope matches what the user saw when
 * picking (selectors resolve on the final model, an implicit profile
 * consumes the scope's last sketch), and bound-variable inputs resolve
 * anywhere after their declaration. The one exception is a projection,
 * which reads the sketch it is called from and so lands inside that
 * sketch's body rather than in the producers' scope.
 */
export type Insertion = { index: number; indent: string; wrap: (stmt: string) => string };

export function resolveInsertion(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  scope: TSNode,
  lines: string[],
  tree: TSTree,
): Insertion | { error: string } {
  if (spec.feature === 'project') {
    return resolveSketchBodyInsertion(spec.project!.sketch, bindings, lines, tree);
  }
  // A connector or exposure registers on the enclosing part, so it lands
  // inside that part's callback body rather than in the producers' hoisted
  // scope.
  if (spec.feature === 'connector') {
    return resolvePartBodyInsertion(spec.connector!.part, bindings, lines, tree);
  }
  if (spec.feature === 'expose') {
    return resolvePartBodyInsertion(spec.expose!.part, bindings, lines, tree);
  }
  return findInsertionPoint(scope, lines, bindings);
}

/**
 * Insertion at the end of a sketch's callback body — the projection tool's
 * target. The bound producers stay where they are (outside the sketch), so
 * the statement only type-checks if their declarations already precede the
 * sketch call: a solid built *after* the sketch cannot be projected into it,
 * and saying so beats emitting code that dies in the temporal dead zone.
 */
function resolveSketchBodyInsertion(
  sketchLoc: { line: number; column: number },
  bindings: ProducerBinding[],
  lines: string[],
  tree: TSTree,
): Insertion | { error: string } {
  const call = findEditableCallAt(tree, lines, sketchLoc.line);
  if (!call || chainRootCallee(call) !== 'sketch') {
    return {
      error: `no sketch() call found at line ${sketchLoc.line} — is the file in sync with the last render?`,
    };
  }
  const body = findSketchBody(call);
  if (!body) {
    return { error: 'the sketch at that line has no callback body to project into' };
  }

  const sketchStatement = enclosingStatement(call) ?? call;
  const late = bindings.find(b => b.bind && b.statement.startIndex >= sketchStatement.startIndex);
  if (late) {
    return {
      error: 'the picked geometry is built after this sketch — only features declared '
        + 'before the sketch can be projected into it',
    };
  }
  // Preceding in source is not enough: a declaration inside another part()'s
  // callback precedes this sketch textually but its variable is out of scope
  // here — the emitted reference would die as an undefined variable at build
  // time. The binding's scope must enclose the sketch statement (the same
  // rule the in-place project edit applies).
  const outOfScope = bindings.find(b => b.bind
    && !(b.scope.startIndex <= sketchStatement.startIndex
      && b.scope.endIndex >= sketchStatement.endIndex));
  if (outOfScope) {
    return {
      error: 'the picked geometry is declared in a different scope than this sketch — '
        + 'only features visible from the sketch can be projected into it',
    };
  }

  const children = body.namedChildren;
  // Land before an active breakpoint(); — a paused build never runs
  // statements after it, so the projection would silently not appear.
  const breakpointStmt = children.find(isBreakpointStatement);
  if (breakpointStmt) {
    const indent = indentOf(lines, breakpointStmt.startPosition.row);
    return { index: breakpointStmt.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }
  const last = children.length > 0 ? children[children.length - 1] : null;
  if (last) {
    const indent = indentOf(lines, last.startPosition.row);
    return { index: last.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
  }
  // An empty body: open the first line of it at one level in from the sketch.
  const indent = indentOf(lines, body.startPosition.row) + '  ';
  return { index: body.startIndex + 1, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}

/**
 * Insertion at the end of a part's callback body — the connector tool's
 * target, and (with no bindings) the active-part home for the producer-less
 * appends. Within the body, the statement prefers the producers' own nearest
 * block: a parameterized part builds each variant inside an `if/else` branch
 * and returns from it, so end-of-branch (before that branch's `return`) is
 * where the statement still executes. The walk from that block up to the
 * part body must cross only plain statement blocks — crossing a nested
 * function or loop (a scope that runs zero-or-many times) falls back to the
 * part body itself. Bound producers must live inside the body: a variable
 * declared elsewhere isn't visible at the insertion point.
 */
export function resolvePartBodyInsertion(
  partLoc: { line: number; column: number },
  bindings: ProducerBinding[],
  lines: string[],
  tree: TSTree,
): Insertion | { error: string } {
  const call = findEditableCallAt(tree, lines, partLoc.line);
  if (!call || chainRootCallee(call) !== 'part') {
    return {
      error: `no part() call found at line ${partLoc.line} — is the file in sync with the last render?`,
    };
  }
  const body = findSketchBody(call);
  if (!body) {
    return { error: 'the part at that line has no callback body to add the statement to' };
  }

  const insideBody = (node: TSNode) =>
    node.startIndex >= body.startIndex && node.endIndex <= body.endIndex;
  const outside = bindings.find(b => b.bind && !insideBody(b.statement));
  if (outside) {
    return {
      error: 'the picked geometry is declared outside this part() body — '
        + 'only features inside the part can source its connectors and exposures',
    };
  }

  let scope = body;
  const statement = bindings[0]?.statement;
  if (statement && insideBody(statement)) {
    const nearest = enclosingScope(statement);
    let crossesRisky = false;
    let current: TSNode | null = nearest;
    while (current && !sameNode(current, body)) {
      if (FUNCTION_NODE_TYPES.has(current.type) || LOOP_NODE_TYPES.has(current.type)) {
        crossesRisky = true;
        break;
      }
      current = current.parent;
    }
    if (!crossesRisky && current) {
      scope = nearest;
    }
  }

  const children = scope.namedChildren;
  if (children.length === 0) {
    // An empty body: open the first line of it at one level in from the part.
    // A single-line `{}` keeps its closing brace on the opening line — move
    // it below the statement.
    const baseIndent = indentOf(lines, scope.startPosition.row);
    const indent = baseIndent + '  ';
    const singleLine = scope.startPosition.row === scope.endPosition.row;
    return {
      index: scope.startIndex + 1,
      indent,
      wrap: (stmt) => singleLine ? `\n${indent}${stmt}\n${baseIndent}` : `\n${indent}${stmt}`,
    };
  }
  return findInsertionPoint(scope, lines, bindings);
}

/**
 * The insertion that lands `decls` (from {@link SelectHoist}) on the lines
 * before `anchor`, at its indent — the sketch statement for a projection's
 * selections, the feature statement itself for a chained call's.
 */
export function declarationsBefore(anchor: TSNode, decls: string[], lines: string[]): { index: number; text: string }[] {
  if (decls.length === 0) {
    return [];
  }
  const indent = indentOf(lines, anchor.startPosition.row);
  return [{ index: anchor.startIndex, text: decls.map(decl => `${decl}\n${indent}`).join('') }];
}

/**
 * End-of-scope insertion point: after the scope's last statement, but before
 * a trailing `return`. Inserting at the end matches what the user saw — the
 * picked edges survived to the final model, so resolving the selection after
 * the last statement is guaranteed to find them. `indent` is the statement
 * indent at the insertion point, for statements with internal newlines.
 *
 * With an active `breakpoint();` the model the user saw is the paused one —
 * statements after the breakpoint never ran and the selection resolved
 * against the paused state — so the statement lands before the first
 * breakpoint that follows the producers, not after it.
 */
function findInsertionPoint(
  scope: TSNode,
  lines: string[],
  bindings: ProducerBinding[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  const children = scope.namedChildren;

  const latestProducerEnd = Math.max(...bindings.map(b => b.statement.endIndex));
  const breakpointStmt = children.find(c => isBreakpointStatement(c) && c.startIndex >= latestProducerEnd);
  if (breakpointStmt) {
    const indent = indentOf(lines, breakpointStmt.startPosition.row);
    return { index: breakpointStmt.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const last = children.length > 0 ? children[children.length - 1] : null;

  if (last && last.type === 'return_statement') {
    const indent = indentOf(lines, last.startPosition.row);
    return { index: last.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const anchor = last ?? bindings[0].statement;
  const indent = indentOf(lines, anchor.startPosition.row);
  return { index: anchor.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}
