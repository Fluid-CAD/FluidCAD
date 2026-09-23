// Applying a solved emission: hoist the targets to bindings and append the statement to the sketch body.

import {
  declareParamStatementsFor,
  declareSketchVariable,
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  isBreakpointStatement,
  isDerivedOpStatement,
  isExpressionText,
  isSolvedConstraintStatement,
  joinLines,
  spliceCode,
  splitLines,
} from '../code-editor/index.ts';
import { SOLVED_CONSTRAINT_KINDS, SOLVED_GEOMETRY_CALLEES } from '../sketch-symbols.ts';
import { allocateSolvedName, collectIdentifiers } from '../sketch-names.ts';
import { renderSolvedTarget, type SolvedEmissionTarget } from '../../../lib/dist/selection/sketch-target.js';
import {
  boundVariableName,
  calleeName,
  chainBase,
  enclosingLoop,
  enclosingStatement,
  followingPushArray,
  hoistSolvedStatement,
  pushCall,
} from './ast.ts';
import { VARIADIC_CONSTRAINT_KINDS } from './constraint-arity.ts';
import {
  EmissionRefusal,
  refuse,
  type SolvedEmissionResult,
  type SolvedEmissionSpec,
} from './emission-spec.ts';
import { DATUM_COMMANDS, solvedTargetCallee, targetError } from './emission-targets.ts';

/** Collector-array irregular plurals — a loop of copy() statements collects
 * into `copies`, never `copys`. Everything else takes a bare `s`. */
const IRREGULAR_PLURALS: Record<string, string> = { copy: 'copies' };

export async function applySolvedEmission(
  code: string,
  spec: SolvedEmissionSpec,
): Promise<SolvedEmissionResult> {
  if (spec.geometry.length === 0 && spec.constraints.length === 0
    && (spec.removals ?? []).length === 0) {
    return refuse(code, 'nothing to emit');
  }
  for (const g of spec.geometry) {
    if (!SOLVED_GEOMETRY_CALLEES.has(g.kind)) {
      return refuse(code, `unknown entity kind '${g.kind}'`);
    }
    if (!isExpressionText(g.text) || g.text.includes('\n') || g.text.includes(';')
      || !new RegExp(`^${g.kind}\\s*\\(`).test(g.text)) {
      return refuse(code, `invalid ${g.kind} statement text`);
    }
  }
  for (const c of spec.constraints) {
    if (!SOLVED_CONSTRAINT_KINDS.has(c.kind)) {
      return refuse(code, `unknown constraint kind '${c.kind}'`);
    }
    // Variadic kinds take any number of targets above their minimum
    // (everything after the first is constrained against it); the other
    // forms are positional with at most three slots.
    const variadicMin = VARIADIC_CONSTRAINT_KINDS.get(c.kind);
    if (variadicMin !== undefined) {
      if (c.targets.length < variadicMin) {
        return refuse(code, `${c.kind} takes ${variadicMin === 1 ? 'one' : 'two'} or more targets`);
      }
    } else if (c.targets.length < 1 || c.targets.length > 3) {
      return refuse(code, 'a constraint takes one to three targets');
    }
    if (c.valueExpr !== undefined && !isExpressionText(c.valueExpr)) {
      return refuse(code, 'invalid value expression');
    }
    for (const t of c.targets) {
      const error = targetError(t, spec.geometry, false);
      if (error !== null) {
        return refuse(code, error);
      }
    }
  }

  // Local variable declarations land at the top of the sketch body FIRST —
  // they shift every body statement down, so line-addressed targets are
  // re-anchored by the shift. `param()` initializers instead land at top
  // level after the whole edit, so nothing here moves.
  const requestedVars = spec.newVariables ?? [];
  const paramVars = requestedVars.filter(v => /\bparam\s*\(/.test(v.initializer));
  const localVars = requestedVars.filter(v => !/\bparam\s*\(/.test(v.initializer));
  let working = code;
  let lineShift = 0;
  for (const v of [...localVars].reverse()) {
    const declared = await declareSketchVariable(working, spec.sketchLine, v.name, v.initializer);
    if (!declared) {
      return refuse(code, `no sketch statement at line ${spec.sketchLine} — the source changed since the picks were made`);
    }
    working = declared.newCode;
    lineShift += declared.linesAdded;
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(working);
  const lines = splitLines(working);

  const sketchCall = findEditableCallAt(tree, lines, spec.sketchLine);
  const body = sketchCall ? findSketchBody(sketchCall) : null;
  if (!sketchCall || !body) {
    return refuse(code, `no sketch statement at line ${spec.sketchLine} — the source changed since the picks were made`);
  }

  // Removals resolve against the same (post-declaration) tree as the targets.
  // Only an unbound, single-line constraint statement inside the sketch body
  // — and outside any loop — qualifies: it is a leaf row nothing else can
  // reference, so deleting its whole line is always safe.
  const removalRows: number[] = [];
  {
    const targetLines = new Set(spec.constraints
      .flatMap(c => c.targets)
      .map(t => t.line)
      .filter((l): l is number => typeof l === 'number'));
    const seen = new Set<number>();
    for (const r of spec.removals ?? []) {
      if (!Number.isInteger(r.line) || r.line < 1) {
        return refuse(code, `invalid removal line '${r.line}'`);
      }
      if (targetLines.has(r.line)) {
        return refuse(code, `line ${r.line} is both a constraint target and a removal`);
      }
      if (seen.has(r.line)) {
        continue;
      }
      seen.add(r.line);
      const call = findEditableCallAt(tree, lines, r.line + lineShift);
      if (!call) {
        return refuse(code, `no statement at line ${r.line} — the source changed since the picks were made`);
      }
      const callee = calleeName(chainBase(call));
      if (!callee || !SOLVED_CONSTRAINT_KINDS.has(callee)) {
        return refuse(code, `line ${r.line} is not a constraint statement`);
      }
      const statement = enclosingStatement(call);
      if (statement.type !== 'expression_statement') {
        return refuse(code, `line ${r.line} is a bound statement — only plain constraint statements can be removed`);
      }
      if (statement.startIndex < body.startIndex || statement.endIndex > body.endIndex) {
        return refuse(code, `line ${r.line} is outside the sketch body`);
      }
      if (enclosingLoop(call, body)) {
        return refuse(code, `line ${r.line} is inside a loop — it constrains every iteration, edit the source instead`);
      }
      const row = statement.startPosition.row;
      if (statement.endPosition.row !== row) {
        return refuse(code, `line ${r.line} spans multiple lines`);
      }
      if (lines[row].trim() !== statement.text.trim()) {
        return refuse(code, `line ${r.line} holds more than the constraint statement`);
      }
      removalRows.push(row);
    }
  }

  const used = collectIdentifiers(tree);
  // Every source edit is a pure insertion resolved against the original tree
  // and applied back-to-front by byte index. Const hoists are same-line
  // prefix splices; the loop-collector edits add WHOLE rows, tracked in
  // insertedRows so the placement row math below can compensate.
  const edits: { start: number; text: string }[] = [];
  const insertedRows: number[] = [];
  // Two targets can name the same statement (a line's length is
  // distance(l.start(), l.end(), …)) — hoist it once and reuse the name.
  const hoistedNames = new Map<number, string>();
  // Loop-instance targets on the same statement share one collector array
  // (distinct occurrences become distinct indices into it).
  const loopArrays = new Map<number, string>();
  // Line-addressed targets pin the constraint's placement: rows (pre-edit,
  // shiftRow-corrected later) just past each referenced statement — or its
  // enclosing loop — plus the row whose indent the constraint copies. The
  // constraint must execute after every binding it references, and a
  // referenced statement can legally sit BELOW the constraints region (a
  // copy() in the derived-ops tail, or a hand-written entity down there).
  const targetAnchors: { after: number; indentRow: number }[] = [];
  // Every emitted statement is bound from the start, referenced by a
  // constraint or not: its name is its region key (`region('c2')`), where an
  // unbound statement only has an ordinal that shifts under later edits.
  // Names go to the new statements first, in emission order — a rectangle
  // reads l1..l4 top to bottom whatever order its constraints name the
  // sides in — and to hoisted existing statements after, as the targets
  // reference them.
  const newNames: string[] = spec.geometry.map(g => allocateSolvedName(used, g.kind));

  // Collector arrays read as the plural of what they collect — `lines`,
  // `arcs`, `projects`, `copies` — falling back to a numbered suffix on
  // collision.
  const allocateArrayName = (callee: string): string => {
    const base = IRREGULAR_PLURALS[callee] ?? `${callee}s`;
    let name = base;
    let n = 1;
    while (used.has(name)) {
      n++;
      name = `${base}${n}`;
    }
    used.add(name);
    return name;
  };

  const datumImports = new Set<string>();
  const constraintTexts: string[] = [];
  for (const c of spec.constraints) {
    const argNames: string[] = [];
    // Bind one target through the existing hoist/collector rail. The shared
    // renderer composes its point/ref/instance accessors and recursively
    // asks for each mirror source binding. Refusals remain atomic below.
    const nameFor = (target: SolvedEmissionTarget): string => {
      if (target.datum !== undefined) {
        const command = DATUM_COMMANDS[target.datum];
        datumImports.add(command);
        return `${command}()`;
      }
      let name: string;
      if (typeof target.newIndex === 'number') {
        name = newNames[target.newIndex];
      } else {
        const line = target.line! + lineShift;
        const call = findEditableCallAt(tree, lines, line);
        if (!call) {
          throw new EmissionRefusal(`no statement at line ${target.line} — the source changed since the picks were made`);
        }
        const statement = enclosingStatement(call);
        const loop = enclosingLoop(call, body);
        // A previous loop-instance emission wrapped the entity call in
        // `<collector>.push(…)` — findEditableCallAt returns the outermost
        // call on the row, so unwrap it for the callee checks and reuse the
        // collector below.
        const wrapped = loop ? pushCall(call) : null;
        const entityCall = wrapped && wrapped.argument.type === 'call_expression'
          ? wrapped.argument
          : call;
        const callee = solvedTargetCallee(entityCall, target);
        if (loop) {
          // Loop-instance rail: the statement executes once per iteration, so
          // a `const` hoisted inside the loop body would be out of scope at
          // the constraint row — collect the instances into an array hoisted
          // before the OUTERMOST enclosing loop and index it per target.
          let arrayName = loopArrays.get(statement.startIndex);
          if (arrayName === undefined) {
            const bound = boundVariableName(statement);
            const existing = wrapped
              ? wrapped.arrayName
              : bound !== null ? followingPushArray(statement, bound) : null;
            if (existing !== null) {
              arrayName = existing;
            } else {
              arrayName = allocateArrayName(callee!);
              const loopRow = loop.startPosition.row;
              edits.push({
                start: loop.startIndex - loop.startPosition.column,
                text: `${indentOf(lines, loopRow)}const ${arrayName} = [];\n`,
              });
              insertedRows.push(loopRow);
              if (bound !== null) {
                // Keep the binding (intra-loop uses stay valid) and feed the
                // collector on a new statement right after it.
                const stmtIndent = indentOf(lines, statement.startPosition.row);
                edits.push({
                  start: statement.endIndex,
                  text: `\n${stmtIndent}${arrayName}.push(${bound});`,
                });
                insertedRows.push(statement.endPosition.row + 1);
              } else {
                edits.push({ start: call.startIndex, text: `${arrayName}.push(` });
                edits.push({ start: call.endIndex, text: ')' });
              }
            }
            loopArrays.set(statement.startIndex, arrayName);
          }
          name = `${arrayName}[${target.occurrence ?? 0}]`;
        } else if (target.occurrence !== undefined) {
          throw new EmissionRefusal(`line ${target.line} runs more than once (helper function) — collect its results into an array to constrain one instance`);
        } else {
          name = hoistSolvedStatement(statement, callee, used, hoistedNames, edits);
        }
        // Record the placement anchor: the constraint must land after this
        // statement's binding exists — the whole loop for loop-rail targets
        // (the collector only fills as the loop runs), the statement itself
        // otherwise.
        const anchor = loop ?? statement;
        targetAnchors.push({
          after: anchor.endPosition.row + 1,
          indentRow: anchor.startPosition.row,
        });
      }
      return name;
    };
    for (const target of c.targets) {
      let name: string;
      try {
        name = renderSolvedTarget(target, nameFor);
      } catch (err) {
        if (err instanceof EmissionRefusal) {
          return refuse(code, err.message);
        }
        throw err;
      }
      argNames.push(name);
    }
    const args = [...argNames];
    if (c.valueExpr !== undefined) {
      args.push(c.valueExpr);
    }
    if (c.axis !== undefined) {
      args.push(`'${c.axis}'`);
    }
    const suffix = c.tangency === 'max' ? '.max()' : '';
    constraintTexts.push(`${c.kind}(${args.join(', ')})${suffix};`);
  }

  // Insertions apply back-to-front so earlier byte offsets stay valid. The
  // loop-collector edits added whole rows (unlike const hoists, which stay on
  // their line) — shiftRow maps a row computed from the pre-edit tree to its
  // post-edit position, so the placement math below still holds.
  let result = working;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = spliceCode(result, edit.start, edit.start, edit.text);
  }
  const shiftRow = (row: number): number =>
    row + insertedRows.reduce((shift, at) => shift + (at <= row ? 1 : 0), 0);

  // Placement (locked §0.2, amended P6): the body reads geometry →
  // constraints → derived ops. Constraints append at the end of their region
  // — before the first derived-op statement when one exists — and geometry
  // inserts before the body's first constraint statement; everything lands
  // before an active breakpoint (a paused build never runs statements after
  // it).
  //
  // Referenced-statement amendment: a constraint referencing a binding whose
  // statement sits BELOW the normal constraints region — a 2D copy() in the
  // derived-ops tail (`cp1.instance(k)`), or a hand-written entity statement
  // down there — cannot sit in that region: the reference would be a TDZ
  // ReferenceError (`Cannot access 'l1' before initialization`). So the
  // constraint row becomes max(the normal row, the row just past EVERY
  // referenced statement — a loop-rail target anchors on its whole enclosing
  // loop, since the collector only fills as the loop runs). Geometry
  // placement is untouched, and an emission whose targets all sit above the
  // constraints region (the overwhelmingly common case) keeps the normal
  // policy byte-identical — every anchor row is already ≤ the computed row.
  const resultLines = splitLines(result);
  const bodyChildren = body.namedChildren;
  const breakpointStmt = bodyChildren.find(isBreakpointStatement);
  const firstConstraintStmt = bodyChildren.find(isSolvedConstraintStatement);
  const firstDerivedStmt = bodyChildren.find(isDerivedOpStatement);

  let constraintRow: number;
  let constraintIndent: string;
  if (firstDerivedStmt
    && (!breakpointStmt || firstDerivedStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    constraintRow = shiftRow(firstDerivedStmt.startPosition.row);
    constraintIndent = indentOf(resultLines, constraintRow);
  } else if (breakpointStmt) {
    constraintRow = shiftRow(breakpointStmt.startPosition.row);
    constraintIndent = indentOf(resultLines, constraintRow);
  } else if (bodyChildren.length > 0) {
    // "Body end" stops BEFORE a trailing return (hand-written sketches
    // return their entity bag) — a statement after it never runs.
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    constraintRow = lastStmt.type === 'return_statement'
      ? shiftRow(lastStmt.startPosition.row)
      : shiftRow(lastStmt.endPosition.row + 1);
    constraintIndent = indentOf(resultLines, shiftRow(lastStmt.startPosition.row));
  } else {
    constraintRow = shiftRow(body.startPosition.row + 1);
    constraintIndent = indentOf(resultLines, shiftRow(body.startPosition.row)) + '  ';
  }

  let geometryRow = constraintRow;
  let geometryIndent = constraintIndent;
  if (firstConstraintStmt
    && (!breakpointStmt || firstConstraintStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    geometryRow = shiftRow(firstConstraintStmt.startPosition.row);
    geometryIndent = indentOf(resultLines, geometryRow);
  }

  // Referenced-statement amendment (see the placement comment above): push
  // the constraint row down past the LAST referenced statement's anchor.
  // Runs AFTER geometryRow is derived so geometry placement never moves; the
  // splice-order invariant below survives because the row only grows.
  if (targetAnchors.length > 0) {
    const last = targetAnchors.reduce((a, b) => (shiftRow(b.after) > shiftRow(a.after) ? b : a));
    const afterAnchorRow = shiftRow(last.after);
    if (afterAnchorRow > constraintRow) {
      constraintRow = afterAnchorRow;
      constraintIndent = indentOf(resultLines, shiftRow(last.indentRow));
    }
  }

  const geometryTexts = spec.geometry.map((g, i) => {
    const guide = g.guide && !g.text.includes('.guide(') ? '.guide()' : '';
    return `${geometryIndent}const ${newNames[i]} = ${g.text}${guide};`;
  });

  // Constraints splice first (the higher row), then geometry (lower or equal
  // row) — so neither splice invalidates the other's row.
  if (constraintTexts.length > 0) {
    resultLines.splice(constraintRow, 0, ...constraintTexts.map(t => `${constraintIndent}${t}`));
  }
  if (geometryTexts.length > 0) {
    resultLines.splice(geometryRow, 0, ...geometryTexts);
  }
  // Removals last, back-to-front, mapped past both insertions. A removal is
  // always a constraint statement, so its row is at or below the body's
  // first constraint statement — which is exactly where geometry inserts —
  // meaning every removal lands BELOW the inserted geometry lines: the
  // reported geometryLines (and the sketch's own line, above the body) never
  // need re-adjusting for removals.
  if (removalRows.length > 0) {
    const finalRemovalRows = removalRows.map(row => {
      const rr = shiftRow(row);
      return rr
        + (rr >= constraintRow ? constraintTexts.length : 0)
        + (rr >= geometryRow ? geometryTexts.length : 0);
    });
    for (const row of finalRemovalRows.sort((a, b) => b - a)) {
      resultLines.splice(row, 1);
    }
  }
  result = joinLines(resultLines);
  const rowsBeforeImports = resultLines.length;

  // A `param()` declaration goes at the top of the part body the sketch
  // lives in — anchored on the sketch's post-emission line, before any
  // import can shift it.
  if (paramVars.length > 0) {
    const emittedSketchLine = shiftRow(enclosingStatement(sketchCall).startPosition.row) + 1;
    result = await declareParamStatementsFor(
      result, emittedSketchLine, paramVars.map(v => `const ${v.name} = ${v.initializer};`),
    );
  }
  for (const kind of new Set(spec.geometry.map(g => g.kind))) {
    result = await ensureSymbolImport(result, kind, 'fluidcad/core');
  }
  for (const command of datumImports) {
    result = await ensureSymbolImport(result, command, 'fluidcad/core');
  }
  for (const kind of new Set(spec.constraints.map(c => c.kind))) {
    result = await ensureSymbolImport(result, kind, 'fluidcad/constraints');
  }
  if (paramVars.length > 0) {
    result = await ensureSymbolImport(result, 'param');
  }

  // Imports and param declarations only ever add lines ABOVE the sketch —
  // shift the reported geometry lines (and the sketch's own line) by
  // however many appeared.
  const importShift = splitLines(result).length - rowsBeforeImports;
  const geometryLines = spec.geometry.map((_, i) => geometryRow + i + 1 + importShift);
  const sketchLine = shiftRow(enclosingStatement(sketchCall).startPosition.row) + 1 + importShift;

  return { newCode: result, geometryLines, names: newNames, sketchLine };
}
