// Editing an existing feature statement in place.

import {
  clearBreakpoints as stripBreakpoints,
  declareParamStatements,
  ensureSymbolImport,
  findEditableCallAt,
  findEnclosingPart,
  getJavaScriptParser,
  indentOf,
  spliceCode,
  splitLines,
} from '../../code-editor.ts';
import { SelectHoist } from '../../select-hoist.ts';
import { numericVarNames } from '../ast/args.ts';
import { enclosingScope, enclosingSketchStatement, enclosingStatement, sameNode } from '../ast/nodes.ts';
import { declarationsBefore } from '../insertion.ts';
import { parseFeatureChain } from '../parse/feature-chain.ts';
import { allocateNames, resolveProducerBindings, type ProducerBinding } from '../producers/bindings.ts';
import { renderEditedStatement } from '../render/edited-statement.ts';
import { importsForRawArgs, MODULE_FOR_IMPORT } from '../render/selectors.ts';
import { renderNewVariableDecls } from '../render/variable-decls.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec } from '../spec.ts';

/**
 * Rewrite the feature statement at `spec.edit.line` in place: re-parse the
 * chain from the live source (nothing captured at dialog-open time can go
 * stale), apply the dialog's options over it, and splice the rendered chain
 * over the old one. A `const x = ` binding and any chained calls after the
 * recognized options survive untouched.
 *
 * Re-sourced slots bind their producers exactly like create mode (reuse an
 * existing `const`, or prepend `const <name> = ` to the bare statement) —
 * with one extra rule the create path never needs: a producer's statement
 * must lie strictly before the edited statement in the same scope, because
 * the rewritten statement executes where it already is. A producer at or
 * after it would be a self or forward reference.
 */
export async function applyStatementEdit(code: string, spec: ApplyFeatureEditSpec): Promise<ApplyFeatureEditResult> {
  const edit = spec.edit!;
  if (!Number.isInteger(edit.line) || edit.line < 1) {
    return { newCode: code, error: 'malformed edit spec: bad line' };
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, edit.line);
  if (!call) {
    return { newCode: code, error: `no call found at line ${edit.line} — is the file in sync with the last render?` };
  }
  const chain = parseFeatureChain(call, code, numericVarNames(tree));
  if ('error' in chain) {
    return { newCode: code, error: chain.error };
  }
  if (chain.parsed.feature !== spec.feature) {
    return {
      newCode: code,
      error: `the statement at line ${edit.line} is a ${chain.parsed.feature}, `
        + `expected a ${spec.feature} — is the file in sync with the last render?`,
    };
  }
  if (edit.expectedStatement !== undefined
    && code.slice(chain.start, chain.end) !== edit.expectedStatement) {
    return {
      newCode: code,
      error: 'the statement changed since the dialog opened — re-open it to edit the current code',
    };
  }
  let bindings: ProducerBinding[] = [];
  if (spec.producers.length > 0 || spec.parts.length > 0) {
    const resolved = resolveProducerBindings(tree, lines, spec);
    if ('error' in resolved) {
      return { newCode: code, error: resolved.error };
    }
    bindings = resolved.bindings;

    const editedStatement = enclosingStatement(call);
    if (!editedStatement) {
      return { newCode: code, error: `no statement found at line ${edit.line}` };
    }
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (binding.statement.startIndex >= chain.start) {
        return {
          newCode: code,
          error: `the input at line ${spec.producers[i].line} does not precede the edited statement — `
            + 'a statement cannot consume itself or later results',
        };
      }
      // A projection's sources live OUTSIDE the sketch body its statement
      // sits in, so any scope enclosing the edited statement is in reach
      // (the ordering check above already guarantees visibility). Everything
      // else keeps the strict same-scope rule.
      const scopeOk = spec.feature === 'project'
        ? binding.scope.startIndex <= editedStatement.startIndex
          && binding.scope.endIndex >= editedStatement.endIndex
        : sameNode(binding.scope, enclosingScope(editedStatement));
      if (!scopeOk) {
        return {
          newCode: code,
          error: `the input at line ${spec.producers[i].line} lives in a different scope than the edited statement`,
        };
      }
    }
    allocateNames(tree.rootNode, bindings, spec);
  }

  const rendered = renderEditedStatement(
    chain.parsed, spec, producer => bindings[producer]?.varName ?? null,
  );
  if ('error' in rendered) {
    return { newCode: code, error: rendered.error };
  }

  // Splice highest-offset first: producer bindings precede the statement, so
  // the statement replacement never shifts under a `const <name> = ` prepend.
  type Edit = { start: number; end: number; text: string };
  let statementText = rendered.statement;
  const edits: Edit[] = [];
  // A rewritten projection's global `select(…)` arguments must run OUTSIDE
  // the sketch body — select captures whatever container it executes in, so
  // from inside the sketch callback it resolves against the sketch's own
  // scope and the projection silently drops. Lift each to a declaration
  // before the sketch, exactly like the create path.
  // Every other feature lifts the selections that would run after it (a loft
  // connection's, inside `.connect(…)`) to the lines before its own statement
  // — kept verbatim text included, which heals a hand-written inline one.
  const editedStatementNode = enclosingStatement(call) ?? call;
  const useSemicolon = editedStatementNode.text.trimEnd().endsWith(';');
  const usedNames = SelectHoist.usedNames(
    tree, [...bindings.map(b => b.varName), ...(spec.newVariables ?? []).map(v => v?.name)],
  );
  let hoistAnchor = editedStatementNode;
  if (chain.parsed.feature === 'project') {
    const sketchStatement = enclosingSketchStatement(call);
    if (!sketchStatement) {
      return { newCode: code, error: `the ${chain.parsed.op}() at line ${edit.line} is not inside a sketch body` };
    }
    hoistAnchor = sketchStatement;
  }
  const hoisted = await SelectHoist.extract(
    statementText, chain.parsed.feature === 'project' ? 'all' : 'late', usedNames, useSemicolon,
  );
  statementText = hoisted.statement;
  edits.push(...declarationsBefore(hoistAnchor, hoisted.decls, lines)
    .map(e => ({ start: e.index, end: e.index, text: e.text })));
  edits.push({ start: chain.start, end: chain.end, text: statementText });
  for (const binding of bindings) {
    if (binding.needsBinding) {
      edits.push({ start: binding.call.startIndex, end: binding.call.startIndex, text: `const ${binding.varName} = ` });
    }
  }
  // Declarations a dialog expression field committed land on the line before
  // the edited statement (its `const x = ` binding included), at its indent.
  const stmtNode = enclosingStatement(call);
  const declsResult = renderNewVariableDecls(
    code, spec.newVariables, (stmtNode ?? call).text.trimEnd().endsWith(';'),
  );
  if ('error' in declsResult) {
    return { newCode: code, error: declsResult.error };
  }
  if (declsResult.decls.length > 0) {
    const anchor = stmtNode ?? call;
    const indent = indentOf(lines, anchor.startPosition.row);
    edits.push({
      start: anchor.startIndex,
      end: anchor.startIndex,
      text: declsResult.decls.map(d => `${d}\n${indent}`).join(''),
    });
  }
  // The edited statement's part takes its `param()` declarations; every
  // edit below lands inside that part's body, so its own line holds.
  const enclosingPart = findEnclosingPart(tree, (stmtNode ?? call).startPosition.row);
  const partLine = enclosingPart ? enclosingPart.call.startPosition.row + 1 : null;
  // Ties (a pure insertion at the statement's own start) must splice after
  // the replacement, so the inserted text never lands inside the replaced
  // span — hence the end tie-break.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = code;
  for (const e of edits) {
    result = spliceCode(result, e.start, e.end, e.text);
  }
  const landed = await declareParamStatements(result, partLine, declsResult.paramDecls);
  if ('error' in landed) {
    return { newCode: code, error: landed.error };
  }
  result = landed.newCode;

  const callee = spec.feature === 'extrude'
    ? (edit.extrude!.op === 'remove' ? 'cut' : 'extrude')
    : spec.feature === 'boolean'
      ? edit.boolean!.kind
      : chain.parsed.feature === 'project'
        ? chain.parsed.op
        : spec.feature;
  result = await ensureSymbolImport(result, callee);
  const imports = new Set(spec.imports ?? []);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      imports.add(symbol);
    }
  }
  if (declsResult.paramDecls.length > 0) {
    imports.add('param');
  }
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
  // Clearing the edit's breakpoint here — one transform, one write — keeps
  // the rewrite and the clear from racing had the UI cleared it separately.
  if (spec.clearBreakpoints) {
    result = (await stripBreakpoints(result)).newCode;
  }
  return { newCode: result };
}
