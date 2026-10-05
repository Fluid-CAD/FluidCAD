// Binding existing sketch statements so a new row can reference them: the
// rail the constraint emission, the sketch exports and the region
// declarations share.
//
// A statement addressed by source line becomes a name in three ways: it is
// already bound (`const l1 = line(…)` → `l1`); it is a bare expression
// statement, which gets a `const <hint><n> = ` prefix spliced in front of it
// (hoisted); or it sits inside a user loop, where a `const` would be out of
// scope at the new row — its instances are collected into an array hoisted
// before the outermost enclosing loop and addressed per run (`lines[2]`).
// Every edit is a pure insertion against the tree the binder was built
// over; the caller applies them back-to-front and maps rows through
// {@link StatementBinder.shiftRow}.

import { findEditableCallAt, indentOf, type TSNode } from '../code-editor/index.ts';
import { allocateSolvedName } from '../sketch-names.ts';
import {
  boundVariableName,
  enclosingLoop,
  enclosingStatement,
  followingPushArray,
  hoistSolvedStatement,
  pushCall,
} from './ast.ts';
import { EmissionRefusal } from './emission-spec.ts';

/** Collector-array irregular plurals — a loop of copy() statements collects
 * into `copies`, never `copys`. Everything else takes a bare `s`. */
const IRREGULAR_PLURALS: Record<string, string> = { copy: 'copies' };

export type BinderEdit = { start: number; text: string };

/** Where a row referencing a bound statement may land: just past the statement (or its loop), at that indent. */
export type BinderAnchor = { after: number; indentRow: number };

export class StatementBinder {
  /** Pure insertions against the original tree, in no particular order. */
  readonly edits: BinderEdit[] = [];
  /** Rows (pre-edit) before which a whole row was inserted — see {@link shiftRow}. */
  readonly insertedRows: number[] = [];
  /** One anchor per bound line-addressed statement. */
  readonly anchors: BinderAnchor[] = [];

  private readonly hoistedNames = new Map<number, string>();
  private readonly loopArrays = new Map<number, string>();

  constructor(
    private readonly tree: { rootNode: TSNode },
    private readonly lines: string[],
    private readonly body: TSNode,
    private readonly used: Set<string>,
  ) {}

  /**
   * The name that references the statement whose outermost call sits at
   * `line` (1-indexed), binding it first when needed. `verify` sees the
   * entity call (unwrapped from a collector `push`) and returns its callee,
   * or throws an {@link EmissionRefusal}. `occurrence` is the run index of
   * a loop statement; on a statement outside any loop it is refused.
   */
  bind(
    line: number,
    occurrence: number | undefined,
    verify: (entityCall: TSNode, statement: TSNode) => string,
    missing: string = `no statement at line ${line} — the source changed since the picks were made`,
  ): string {
    const call = findEditableCallAt(this.tree, this.lines, line);
    if (!call) {
      throw new EmissionRefusal(missing);
    }
    const statement = enclosingStatement(call);
    const loop = enclosingLoop(call, this.body);
    // A previous loop-instance emission wrapped the entity call in
    // `<collector>.push(…)` — findEditableCallAt returns the outermost call
    // on the row, so unwrap it for the callee checks and reuse the collector.
    const wrapped = loop ? pushCall(call) : null;
    const entityCall = wrapped && wrapped.argument.type === 'call_expression'
      ? wrapped.argument
      : call;
    const callee = verify(entityCall, statement);

    let name: string;
    if (loop) {
      let arrayName = this.loopArrays.get(statement.startIndex);
      if (arrayName === undefined) {
        const bound = boundVariableName(statement);
        const existing = wrapped
          ? wrapped.arrayName
          : bound !== null ? followingPushArray(statement, bound) : null;
        if (existing !== null) {
          arrayName = existing;
        } else {
          arrayName = this.allocateArrayName(callee);
          const loopRow = loop.startPosition.row;
          this.edits.push({
            start: loop.startIndex - loop.startPosition.column,
            text: `${indentOf(this.lines, loopRow)}const ${arrayName} = [];\n`,
          });
          this.insertedRows.push(loopRow);
          if (bound !== null) {
            // Keep the binding (intra-loop uses stay valid) and feed the
            // collector on a new statement right after it.
            const stmtIndent = indentOf(this.lines, statement.startPosition.row);
            this.edits.push({
              start: statement.endIndex,
              text: `\n${stmtIndent}${arrayName}.push(${bound});`,
            });
            this.insertedRows.push(statement.endPosition.row + 1);
          } else {
            this.edits.push({ start: call.startIndex, text: `${arrayName}.push(` });
            this.edits.push({ start: call.endIndex, text: ')' });
          }
        }
        this.loopArrays.set(statement.startIndex, arrayName);
      }
      name = `${arrayName}[${occurrence ?? 0}]`;
    } else if (occurrence !== undefined) {
      throw new EmissionRefusal(`line ${line} runs more than once (helper function) — collect its results into an array to reference one instance`);
    } else {
      name = hoistSolvedStatement(statement, callee, this.used, this.hoistedNames, this.edits);
    }
    // The new row must land after this statement's binding exists — the
    // whole loop for loop-rail targets (the collector only fills as the loop
    // runs), the statement itself otherwise.
    const anchor = loop ?? statement;
    this.anchors.push({ after: anchor.endPosition.row + 1, indentRow: anchor.startPosition.row });
    return name;
  }

  /** A pre-edit row's position once the whole-row insertions are applied. */
  shiftRow(row: number): number {
    return row + this.insertedRows.reduce((shift, at) => shift + (at <= row ? 1 : 0), 0);
  }

  /** Collector arrays read as the plural of what they collect — `lines`,
   * `arcs`, `copies` — falling back to a numbered suffix on collision. */
  private allocateArrayName(callee: string): string {
    const base = IRREGULAR_PLURALS[callee] ?? `${callee}s`;
    let name = base;
    let n = 1;
    while (this.used.has(name)) {
      n++;
      name = `${base}${n}`;
    }
    this.used.add(name);
    return name;
  }
}

export { allocateSolvedName };
