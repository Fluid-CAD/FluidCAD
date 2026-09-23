// What the sketch Split and Trim tools' statement transforms share: locating
// the entity statement the kernel cut, finding every mention of its binding
// in the sketch body (and the point accessor each feeds), the constraint
// rule tables, and the disjoint-edit splice that applies a rewrite in one
// pass. The transforms themselves decide what each piece and each reference
// becomes.

import {
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  splitLines,
  spliceCode,
  updateSketchPositions,
  walkTree,
  type SketchPositionEdit,
  type TSNode,
  type TSTree,
} from './code-editor.ts';
import {
  boundVariableName,
  calleeName,
  chainBase,
  enclosingLoop,
  enclosingStatement,
} from './sketch-solved-edit.ts';
import { SOLVED_CONSTRAINT_KINDS } from './sketch-symbols.ts';
import { StatementAnalysis } from './statement-analysis.ts';

/** The entity commands the kernel can cut. */
export type EntityCallee = 'line' | 'arc' | 'circle';

/** Their argument counts: line(start, end), arc(start, end, center), circle(center, diameter). */
const ENTITY_ARITY: Record<EntityCallee, number> = { line: 2, arc: 3, circle: 2 };

/** The entity statement a cut acts on, resolved from the source. */
export type EntityStatement = {
  tree: TSTree;
  lines: string[];
  /** The sketch callback's block. */
  body: TSNode;
  /** The whole call chain (`line(…).guide()`). */
  call: TSNode;
  /** The body statement holding it. */
  statement: TSNode;
  /** The entity call itself (`line(…)`). */
  base: TSNode;
  callee: EntityCallee;
  args: TSNode[];
  /** The chained modifiers after the entity call (`.cw().guide()`), verbatim. */
  modifiers: string;
  /** The binding name, or null for a bare expression statement. */
  name: string | null;
};

export type Edit = { start: number; end: number; text: string };

/** A mention of the entity's binding inside the sketch body. */
export type Reference = {
  node: TSNode;
  /** The body statement the mention lives in. */
  statement: TSNode;
  /** The point accessor it feeds (`l.end()` → 'end'), or null for a bare use. */
  role: string | null;
  /** The accessor call expression (`l.end()`), when `role` is set. */
  accessor: TSNode | null;
};

/**
 * How a constraint addressing the WHOLE entity (a bare reference, no point
 * accessor) survives a cut.
 *
 * - `duplicate`: the constraint describes a property every piece inherits
 *   (a line's orientation, a fixed entity) — the first piece keeps it and
 *   every other surviving piece gets a copy.
 * - `position`: the constraint acts at one place along the entity (a point
 *   on it, a tangency, a distance) — it goes to the piece that place falls
 *   on, the first surviving piece by default.
 * - `remove`: no piece can carry it (a line's length equality, a mirror
 *   pair, the line form of midpoint) — deleted, and reported.
 * - `keep` (the default for unlisted kinds): stays on the first piece.
 */
export type ConstraintRule = 'duplicate' | 'position' | 'remove' | 'keep';

export const LINE_RULES: Record<string, ConstraintRule> = {
  horizontal: 'duplicate',
  vertical: 'duplicate',
  parallel: 'duplicate',
  perpendicular: 'duplicate',
  angle: 'duplicate',
  collinear: 'duplicate',
  fix: 'duplicate',
  coincident: 'position',
  tangent: 'position',
  distance: 'position',
  equal: 'remove',
  symmetric: 'remove',
  midpoint: 'remove',
};

/**
 * Arc and circle pieces ride one circle when the transform pins them there
 * (the Split tool's junction and center coincidents), so every constraint
 * on the circle's geometry — radius, diameter, concentric, tangent, equal
 * radii, a point on the circumference — keeps meaning on the first piece
 * alone: only `fix` is duplicated and only `symmetric` (a whole-entity
 * mirror pair) removed.
 */
export const ROUND_RULES: Record<string, ConstraintRule> = {
  fix: 'duplicate',
  symmetric: 'remove',
};

/** 2dp source literals, like every drawing-tool emission. */
export const fmt = (n: number): string => String(Math.round(n * 100) / 100);
export const pointText = (p: [number, number]): string => `[${fmt(p[0])}, ${fmt(p[1])}]`;

export class SketchEntityRewrite extends StatementAnalysis {
  /**
   * Settle the sketch on the geometry the render reported before cutting
   * it: write every drifted solved position into its literal guess (the
   * drag write-back's own transform, same drift guards). The cut's literals
   * then agree with every untouched literal, so the source the cut leaves
   * describes one sketch that is already solved — the re-solve has nothing
   * to move and the geometry stays where the user saw it. Literals never
   * change the line count, so the spec's line numbers survive; a settle
   * that would (a literal spanning lines) refuses rather than cut the wrong
   * statement.
   */
  protected static async settle(
    code: string,
    edits: SketchPositionEdit[] | undefined,
  ): Promise<{ code: string } | { error: string }> {
    if (!edits || edits.length === 0) {
      return { code };
    }
    const settled = await updateSketchPositions(code, edits);
    if (settled.error) {
      return { error: settled.error };
    }
    if (splitLines(settled.newCode).length !== splitLines(code).length) {
      return { error: 'a position literal spans several lines — settle the sketch by hand first' };
    }
    return { code: settled.newCode };
  }

  /**
   * The entity statement at `line` inside the sketch at `sketchLine`, or the
   * reason it cannot be rewritten: the source moved under the pick, the
   * statement sits in a loop, it is not a line/arc/circle statement of the
   * body, or its argument list is not the primitive's.
   */
  protected static async resolveEntity(
    code: string,
    sketchLine: number,
    line: number,
  ): Promise<EntityStatement | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);
    const sketchCall = findEditableCallAt(tree, lines, sketchLine);
    const body = sketchCall ? findSketchBody(sketchCall) : null;
    if (!sketchCall || !body) {
      return { error: `no sketch statement at line ${sketchLine} — the source changed since the pick was made` };
    }
    const call = findEditableCallAt(tree, lines, line);
    if (!call || !SketchEntityRewrite.within(call, body)) {
      return { error: `no sketch statement at line ${line} — the source changed since the pick was made` };
    }
    if (enclosingLoop(call, body)) {
      return { error: `line ${line} is inside a loop — it draws every iteration, edit the source instead` };
    }
    const statement = enclosingStatement(call);
    if (!SketchEntityRewrite.sameSpan(statement.parent!, body)) {
      return { error: `line ${line} is not a statement of the sketch body — edit the entity's own statement` };
    }
    const base = chainBase(call);
    const callee = calleeName(base);
    if (callee !== 'line' && callee !== 'arc' && callee !== 'circle') {
      return { error: `line ${line} is a ${callee ?? 'non-entity'}() statement — only lines, arcs and circles can be cut` };
    }
    const args = base.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length !== ENTITY_ARITY[callee]) {
      return { error: `line ${line}: ${callee}() takes ${ENTITY_ARITY[callee] === 3 ? 'three' : 'two'} arguments` };
    }
    return {
      tree, lines, body, call, statement, base, callee, args,
      modifiers: code.slice(base.endIndex, call.endIndex),
      name: boundVariableName(statement),
    };
  }

  /**
   * Every identifier in `body` that resolves to the entity binding, with the
   * point accessor it feeds (`l.end()`), excluding the binding itself.
   */
  protected static referencesTo(name: string, declaration: TSNode, body: TSNode): Reference[] {
    const refs: Reference[] = [];
    for (const node of walkTree(body)) {
      if (node.type !== 'identifier' || node.text !== name) {
        continue;
      }
      if (SketchEntityRewrite.within(node, declaration) && !SketchEntityRewrite.withinCallArguments(node, declaration)) {
        continue;
      }
      if (!SketchEntityRewrite.resolvesTo(node, declaration, name)) {
        continue;
      }
      const statement = SketchEntityRewrite.bodyStatementOf(node, body);
      if (!statement) {
        continue;
      }
      const accessor = SketchEntityRewrite.accessorCall(node);
      refs.push({
        node,
        statement,
        role: accessor ? accessor.childForFieldName('function')!.childForFieldName('property')!.text : null,
        accessor,
      });
    }
    return refs;
  }

  /** `name` used inside the declaration's own call (`line(l.end(), …)` — impossible for a fresh binding, but a hand-written self-reference must not be mistaken for the binding). */
  private static withinCallArguments(node: TSNode, declaration: TSNode): boolean {
    for (let cur = node.parent; cur && cur.startIndex >= declaration.startIndex; cur = cur.parent) {
      if (cur.type === 'arguments') {
        return true;
      }
    }
    return false;
  }

  /** The point accessor call a reference feeds (`l.end()`), or null for a bare use. */
  private static accessorCall(node: TSNode): TSNode | null {
    const member = node.parent;
    if (!member || member.type !== 'member_expression' || member.childForFieldName('object')?.startIndex !== node.startIndex) {
      return null;
    }
    const property = member.childForFieldName('property');
    const call = member.parent;
    if (!property || !call || call.type !== 'call_expression' || call.childForFieldName('function')?.startIndex !== member.startIndex) {
      return null;
    }
    return call;
  }

  /** The direct child statement of `body` that contains `node`. */
  private static bodyStatementOf(node: TSNode, body: TSNode): TSNode | null {
    for (let cur: TSNode | null = node; cur; cur = cur.parent) {
      if (cur.parent && SketchEntityRewrite.sameSpan(cur.parent, body)) {
        return cur;
      }
    }
    return null;
  }

  /** The constraint kind of a plain `kind(…);` statement, else null. */
  protected static constraintKindOf(statement: TSNode): string | null {
    if (statement.type !== 'expression_statement') {
      return null;
    }
    const call = statement.namedChild(0);
    if (!call || call.type !== 'call_expression') {
      return null;
    }
    const callee = calleeName(chainBase(call));
    return callee !== null && SOLVED_CONSTRAINT_KINDS.has(callee) ? callee : null;
  }

  /** The statement's text with the given identifier nodes renamed. */
  protected static replaceWithin(statement: TSNode, nodes: TSNode[], replacement: string): string {
    let text = statement.text;
    for (const node of [...nodes].sort((a, b) => b.startIndex - a.startIndex)) {
      const from = node.startIndex - statement.startIndex;
      text = text.slice(0, from) + replacement + text.slice(from + node.text.length);
    }
    return text;
  }

  /** A copy of `statement` on the next line, with `nodes` renamed to `replacement`. */
  protected static copyAfter(lines: string[], statement: TSNode, nodes: TSNode[], replacement: string): Edit {
    const indent = indentOf(lines, statement.startPosition.row);
    return {
      start: statement.endIndex,
      end: statement.endIndex,
      text: `\n${indent}${SketchEntityRewrite.replaceWithin(statement, nodes, replacement)}`,
    };
  }

  /** A new statement on the line after `statement`, at its indent. */
  protected static insertAfter(lines: string[], statement: TSNode, text: string): Edit {
    const indent = indentOf(lines, statement.startPosition.row);
    return { start: statement.endIndex, end: statement.endIndex, text: `\n${indent}${text}` };
  }

  /**
   * Apply disjoint `edits` and delete the `removed` statements' rows in one
   * back-to-front splice. An edit inside a removed statement is moot and
   * dropped. A removed statement must own its rows outright: sharing a row
   * with other code refuses, since deleting the row would take that code
   * along. `remapLine` says where a 1-indexed line of the input landed —
   * the emission that follows addresses statements by line.
   */
  protected static splice(
    code: string,
    lines: string[],
    edits: Edit[],
    removed: Iterable<TSNode>,
  ): { code: string; remapLine: (line: number) => number } | { error: string } {
    const doomed = [...removed];
    const live = edits.filter(e => !doomed.some(d => e.start >= d.startIndex && e.end <= d.endIndex && e.text !== ''));
    for (const d of doomed) {
      const startRow = d.startPosition.row;
      const endRow = d.endPosition.row;
      const alone = lines[startRow].slice(0, d.startPosition.column).trim() === ''
        && lines[endRow].slice(d.endPosition.column).trim() === '';
      if (!alone) {
        return { error: `line ${startRow + 1} holds more than the statement — remove it by hand first` };
      }
      const rowStart = d.startIndex - d.startPosition.column;
      const rowEnd = Math.min(code.length, d.endIndex + (lines[endRow].length - d.endPosition.column) + 1);
      live.push({ start: rowStart, end: rowEnd, text: '' });
    }
    live.sort((a, b) => b.start - a.start || b.end - a.end);
    let working = code;
    for (const edit of live) {
      working = spliceCode(working, edit.start, edit.end, edit.text);
    }
    const lineStarts: number[] = [0];
    for (const text of lines) {
      lineStarts.push(lineStarts[lineStarts.length - 1] + text.length + 1);
    }
    const newlines = (text: string): number => text.split('\n').length - 1;
    const remapLine = (line: number): number => {
      const at = lineStarts[line - 1] ?? code.length;
      let delta = 0;
      for (const edit of live) {
        if (edit.start < at) {
          delta += newlines(edit.text) - newlines(code.slice(edit.start, edit.end));
        }
      }
      return line + delta;
    };
    return { code: working, remapLine };
  }

  /**
   * The 1-indexed lines of the body statements binding `names`, in the
   * rewritten code; null when any is missing.
   */
  protected static async locateBindings(
    code: string,
    sketchLine: number,
    names: string[],
  ): Promise<Map<string, number> | null> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);
    const sketchCall = findEditableCallAt(tree, lines, sketchLine);
    const body = sketchCall ? findSketchBody(sketchCall) : null;
    if (!body) {
      return null;
    }
    const located = new Map<string, number>();
    for (const child of body.namedChildren) {
      const bound = boundVariableName(child);
      if (bound !== null && names.includes(bound)) {
        located.set(bound, child.startPosition.row + 1);
      }
    }
    return names.every(n => located.has(n)) ? located : null;
  }
}
