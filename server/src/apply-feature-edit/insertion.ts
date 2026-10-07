// Where a new statement lands: sketch bodies, part bodies, after the last producer, or at top level.

import {
  chainRootCallee,
  declarationImports,
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
} from '../code-editor/index.ts';
import {
  enclosingScope,
  enclosingStatement,
  FUNCTION_NODE_TYPES,
  LOOP_NODE_TYPES,
  sameNode,
  topLevelStatement,
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
  for (const symbol of declarationImports(declsResult.paramDecls)) {
    result = await ensureSymbolImport(result, symbol);
  }
  return { newCode: result };
}

/**
 * Where the feature statement goes: at the end of the scope its inputs pin
 * (see `ProducerBinding.pinsScope`) — before an active `breakpoint();` or a
 * trailing `return`. End of scope matches what the user saw when picking
 * (selectors resolve on the final model, an implicit profile consumes the
 * scope's last sketch), and bound-variable inputs resolve anywhere after
 * their declaration. A statement whose inputs pin no scope — top-level
 * sketches, planes, axes and wires alone — goes to the timeline's active
 * part instead (see {@link resolveUnpinnedInsertion}). The exceptions name
 * their own body: a projection reads the sketch it is called from, so it
 * lands inside that sketch's body, and a connector or exposure registers on
 * its part.
 */
export type Insertion = { index: number; indent: string; wrap: (stmt: string) => string };

export function resolveInsertion(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
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
  const pinning = bindings.filter(binding => binding.pinsScope);
  if (pinning.length === 0) {
    return resolveUnpinnedInsertion(spec.activePart, bindings, lines, tree);
  }
  // The top-level inputs join the pinned scope by variable, so each must be
  // declared before the module statement holding that scope — the part()
  // whose body the pinned inputs live in.
  const scope = pinning[0].scope;
  const holder = topLevelStatement(scope);
  if (holder) {
    const late = bindings.find(binding => !binding.pinsScope && binding.statement.startIndex >= holder.startIndex);
    if (late) {
      const holderLine = holder.startPosition.row + 1;
      return {
        error: `the input at line ${late.statement.startPosition.row + 1} is declared below line ${holderLine}, `
          + `whose body the other inputs place the statement in — move it above line ${holderLine}, then retry`,
      };
    }
  }
  return findInsertionPoint(scope, lines, bindings);
}

/**
 * Where a statement whose inputs pin no scope lands: at the end of the
 * timeline's active part — the home a pick-less sketch takes — so a part
 * body consumes the sketches and datums drawn before the part existed. An
 * input declared below the part would be read before its declaration runs
 * whenever the part builds early, so the statement then stays beside its
 * inputs at the top level, as it does with no part active.
 */
function resolveUnpinnedInsertion(
  partLoc: { line: number; column: number } | undefined,
  bindings: ProducerBinding[],
  lines: string[],
  tree: TSTree,
): Insertion | { error: string } {
  if (partLoc) {
    const call = findEditableCallAt(tree, lines, partLoc.line);
    const partStatement = call && chainRootCallee(call) === 'part' ? topLevelStatement(call) : null;
    // A line that holds no part() goes through too: the part-body
    // resolution refuses it as out of sync.
    if (!partStatement || bindings.every(binding => binding.statement.endIndex <= partStatement.startIndex)) {
      return resolvePartBodyInsertion(partLoc, [], lines, tree);
    }
  }
  return findInsertionPoint(tree.rootNode, lines, bindings);
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
 * appends and the unpinned creates. Within the body, the statement prefers
 * the producers' own nearest block: a parameterized part builds each variant
 * inside an `if/else` branch and returns from it, so end-of-branch (before
 * that branch's `return`) is where the statement still executes. The walk
 * from that block up to the part body must cross only plain statement
 * blocks — crossing a nested function or loop (a scope that runs
 * zero-or-many times) falls back to the part body itself. Bound producers
 * must live inside the body: a variable declared elsewhere isn't visible at
 * the insertion point.
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
