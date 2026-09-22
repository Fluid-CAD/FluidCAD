// The sketch Split tool's statement transform.
//
// The kernel has already cut the entity (lib `SketchEntitySplit`); this
// rewrites the source so the sketch reads as the cut geometry: the statement
// keeps the first piece (and its name, so every `.start()` / `.center()`
// reference stays valid), a new binding right after it takes the second
// piece, `.end()` references move to the new binding, and the constraints
// that addressed the whole entity follow the rule table below. The junction
// coincident(s) then ride the ordinary insert-solved emission rail.

import {
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  splitLines,
  spliceCode,
  walkTree,
  type TSNode,
} from './code-editor.ts';
import {
  allocateSolvedName,
  applySolvedEmission,
  boundVariableName,
  calleeName,
  chainBase,
  collectIdentifiers,
  enclosingLoop,
  enclosingStatement,
  hoistSolvedStatement,
  type SolvedConstraintEmission,
} from './sketch-solved-edit.ts';
import { SOLVED_CONSTRAINT_KINDS } from './sketch-symbols.ts';
import { StatementAnalysis } from './statement-analysis.ts';
import type { SplitPiece } from '../../lib/dist/features/2d/split.js';

export type { SplitPiece };

export type SketchSplitSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  /** 1-indexed line of the entity statement being split. */
  line: number;
  /**
   * The pieces the kernel cut, in travel order: two for a line or an arc,
   * one full-turn arc for a circle. The statement keeps the first; a new
   * binding takes the second.
   */
  pieces: SplitPiece[];
  /**
   * Which piece keeps a constraint that acts somewhere ALONG the entity
   * (a point on it, a tangency, a distance) — by constraint statement
   * line, resolved by the route from where the constraint touches the
   * entity. Unlisted position-bound constraints stay on the first piece.
   */
  assignments?: { line: number; piece: number }[];
};

export type SketchSplitResult = {
  newCode: string;
  error?: string;
  /** Constraint statements the split deleted because no piece can carry
   * them (a line's length, a mirror pair, a midpoint) — for the UI toast. */
  removed?: { line: number; kind: string }[];
  /** The binding names of the pieces, first piece first. */
  names?: string[];
  /** The sketch statement's post-edit line (an added import shifts it). */
  sketchLine?: number;
};

/**
 * How a constraint addressing the WHOLE entity (a bare reference, no point
 * accessor) survives the split.
 *
 * - `duplicate`: the constraint describes a property every piece inherits
 *   (a line's orientation, a fixed entity) — the first piece keeps it and
 *   the second gets a copy.
 * - `position`: the constraint acts at one place along the entity (a point
 *   on it, a tangency, a distance) — it goes to the piece that place falls
 *   on (`assignments`), the first piece by default.
 * - `remove`: no piece can carry it (a line's length equality, a mirror
 *   pair, the line form of midpoint) — deleted, and reported.
 * - `keep` (the default for unlisted kinds): stays on the first piece.
 *
 * Arc and circle pieces ride one circle (the junction and center
 * coincidents pin them), so every constraint on the circle's geometry —
 * radius, diameter, concentric, tangent, equal radii, a point on the
 * circumference — keeps meaning on the first piece alone: only `fix` is
 * duplicated and only `symmetric` (a whole-entity mirror pair) removed.
 */
type SplitRule = 'duplicate' | 'position' | 'remove' | 'keep';

const LINE_RULES: Record<string, SplitRule> = {
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

const ROUND_RULES: Record<string, SplitRule> = {
  fix: 'duplicate',
  symmetric: 'remove',
};

const SPLITTABLE_CALLEES = new Set(['line', 'arc', 'circle']);

/** 2dp source literals, like every drawing-tool emission. */
const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const pointText = (p: [number, number]): string => `[${fmt(p[0])}, ${fmt(p[1])}]`;

type Edit = { start: number; end: number; text: string };

/** A reference to the split entity's name inside the sketch body. */
type Reference = {
  node: TSNode;
  statement: TSNode;
  /** The point accessor called on it (`l.end()` → 'end'), or null for a bare use. */
  role: string | null;
};

export class SketchSplit extends StatementAnalysis {
  static async apply(code: string, spec: SketchSplitSpec): Promise<SketchSplitResult> {
    const refuse = (error: string): SketchSplitResult => ({ newCode: code, error });
    if (spec.pieces.length < 1 || spec.pieces.length > 2) {
      return refuse('a split yields one or two pieces');
    }
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);

    const sketchCall = findEditableCallAt(tree, lines, spec.sketchLine);
    const body = sketchCall ? findSketchBody(sketchCall) : null;
    if (!sketchCall || !body) {
      return refuse(`no sketch statement at line ${spec.sketchLine} — the source changed since the pick was made`);
    }
    const call = findEditableCallAt(tree, lines, spec.line);
    if (!call || !SketchSplit.within(call, body)) {
      return refuse(`no sketch statement at line ${spec.line} — the source changed since the pick was made`);
    }
    if (enclosingLoop(call, body)) {
      return refuse(`line ${spec.line} is inside a loop — it draws every iteration, edit the source instead`);
    }
    const statement = enclosingStatement(call);
    if (!SketchSplit.sameSpan(statement.parent!, body)) {
      return refuse(`line ${spec.line} is not a statement of the sketch body — split the entity's own statement`);
    }
    const base = chainBase(call);
    const callee = calleeName(base);
    if (!callee || !SPLITTABLE_CALLEES.has(callee)) {
      return refuse(`line ${spec.line} is a ${callee ?? 'non-entity'}() statement — only lines, arcs and circles split`);
    }
    const expectedPieces = callee === 'circle' ? 1 : 2;
    const pieceKind = callee === 'line' ? 'line' : 'arc';
    if (spec.pieces.length !== expectedPieces || spec.pieces.some(p => p.kind !== pieceKind)) {
      return refuse(`line ${spec.line} is a ${callee}() statement now — the source changed since the pick was made`);
    }
    const args = base.childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length !== (callee === 'arc' ? 3 : 2)) {
      return refuse(`line ${spec.line}: ${callee}() takes ${callee === 'arc' ? 'three' : 'two'} arguments`);
    }

    const used = collectIdentifiers(tree);
    const edits: Edit[] = [];
    const hoistEdits: { start: number; text: string }[] = [];
    const name = hoistSolvedStatement(statement, callee, used, new Map(), hoistEdits);
    edits.push(...hoistEdits.map(e => ({ start: e.start, end: e.start, text: e.text })));
    const secondName = spec.pieces.length === 2 ? allocateSolvedName(used, pieceKind) : null;

    // The statement's own rewrite: the first piece replaces the arguments
    // that changed (the end, or the whole circle call), keeping every
    // untouched argument's expression — a variable, an accessor — verbatim.
    // Chained modifiers (`.cw()`, `.guide()`) stay on the statement and are
    // copied onto the second piece, which shares its sweep side.
    const at = spec.pieces[0].end;
    const modifiers = code.slice(base.endIndex, call.endIndex);
    let secondText: string | null = null;
    switch (callee) {
      case 'line':
        edits.push({ start: args[1].startIndex, end: args[1].endIndex, text: pointText(at) });
        secondText = `line(${pointText(at)}, ${args[1].text})`;
        break;
      case 'arc':
        edits.push({ start: args[1].startIndex, end: args[1].endIndex, text: pointText(at) });
        secondText = `arc(${pointText(at)}, ${args[1].text}, ${args[2].text})`;
        break;
      case 'circle':
        edits.push({ start: base.startIndex, end: base.endIndex, text: `arc(${pointText(at)}, ${pointText(at)}, ${args[0].text})` });
        break;
    }
    const indent = indentOf(lines, statement.startPosition.row);
    if (secondText !== null) {
      edits.push({
        start: statement.endIndex, end: statement.endIndex,
        text: `\n${indent}const ${secondName} = ${secondText}${modifiers};`,
      });
    }

    // Every other mention of the entity in the body follows its rule.
    const references = SketchSplit.referencesTo(name, statement, body);
    const rules = callee === 'line' ? LINE_RULES : ROUND_RULES;
    const assignments = new Map((spec.assignments ?? []).map(a => [a.line, a.piece]));
    const removed: { line: number; kind: string }[] = [];
    const removedStatements = new Set<number>();
    const duplicated = new Map<number, { statement: TSNode; nodes: TSNode[] }>();
    for (const ref of references) {
      const constraintKind = SketchSplit.constraintKindOf(ref.statement);
      const refLine = ref.statement.startPosition.row + 1;
      if (ref.role !== null) {
        if (ref.role === 'end' && secondName !== null) {
          edits.push({ start: ref.node.startIndex, end: ref.node.endIndex, text: secondName });
        } else if (ref.role === 'mid') {
          if (constraintKind === null) {
            return refuse(`line ${refLine} uses ${name}.mid() — no piece has the entity's midpoint, remove that reference first`);
          }
          SketchSplit.markRemoved(ref.statement, constraintKind, removed, removedStatements);
        }
        continue;
      }
      if (constraintKind === null) {
        // A derived op or geometry statement naming the whole entity: a
        // listed entity (`mirror([l1, l2], …)`) gains the second piece next
        // to it; a positional argument stays with the first piece.
        if (secondName !== null && ref.node.parent?.type === 'array') {
          edits.push({ start: ref.node.endIndex, end: ref.node.endIndex, text: `, ${secondName}` });
        }
        continue;
      }
      switch (rules[constraintKind] ?? 'keep') {
        case 'duplicate': {
          if (secondName === null) {
            break;
          }
          const entry = duplicated.get(ref.statement.startIndex)
            ?? { statement: ref.statement, nodes: [] };
          entry.nodes.push(ref.node);
          duplicated.set(ref.statement.startIndex, entry);
          break;
        }
        case 'position':
          if (secondName !== null && assignments.get(refLine) === 1) {
            edits.push({ start: ref.node.startIndex, end: ref.node.endIndex, text: secondName });
          }
          break;
        case 'remove':
          SketchSplit.markRemoved(ref.statement, constraintKind, removed, removedStatements);
          break;
        case 'keep':
          break;
      }
    }
    for (const { statement: dup, nodes } of duplicated.values()) {
      if (removedStatements.has(dup.startIndex)) {
        continue;
      }
      const copy = SketchSplit.replaceWithin(dup, nodes, secondName!);
      const dupIndent = indentOf(lines, dup.startPosition.row);
      edits.push({ start: dup.endIndex, end: dup.endIndex, text: `\n${dupIndent}${copy}` });
    }
    for (const startIndex of removedStatements) {
      const doomed = references.find(r => r.statement.startIndex === startIndex)!.statement;
      const rowStart = doomed.startIndex - doomed.startPosition.column;
      if (lines[doomed.startPosition.row].trim() !== doomed.text.trim() || doomed.startPosition.row !== doomed.endPosition.row) {
        return refuse(`line ${doomed.startPosition.row + 1} holds more than the constraint statement — remove it by hand first`);
      }
      const rowEnd = Math.min(code.length, doomed.endIndex + (lines[doomed.endPosition.row].length - doomed.endPosition.column) + 1);
      edits.push({ start: rowStart, end: rowEnd, text: '' });
    }

    // Edits inside a removed statement are moot; every remaining edit is
    // disjoint, so back-to-front splicing keeps the indices valid.
    const live = edits.filter(e => ![...removedStatements].some(s => {
      const doomed = references.find(r => r.statement.startIndex === s)!.statement;
      return e.start >= doomed.startIndex && e.end <= doomed.endIndex && e.text !== '';
    }));
    live.sort((a, b) => b.start - a.start || b.end - a.end);
    let working = code;
    for (const edit of live) {
      working = spliceCode(working, edit.start, edit.end, edit.text);
    }

    // The junction: the pieces share their cut point, arcs their center
    // too. Rendered through the emission rail, which places, imports and
    // hoists like any drawing-tool constraint.
    const located = await SketchSplit.locatePieces(working, spec.sketchLine, name, secondName);
    if (!located) {
      return refuse('the split statements could not be located after the rewrite');
    }
    let result = working;
    let sketchLine = spec.sketchLine;
    if (secondName !== null) {
      const featureType = pieceKind;
      const constraints: SolvedConstraintEmission[] = [{
        kind: 'coincident',
        targets: [
          { line: located.first, role: 'end', featureType },
          { line: located.second!, role: 'start', featureType },
        ],
      }];
      if (pieceKind === 'arc') {
        constraints.push({
          kind: 'coincident',
          targets: [
            { line: located.first, role: 'center', featureType },
            { line: located.second!, role: 'center', featureType },
          ],
        });
      }
      const emission = await applySolvedEmission(working, { sketchLine: spec.sketchLine, geometry: [], constraints });
      if (emission.error) {
        return refuse(emission.error);
      }
      result = emission.newCode;
      sketchLine = emission.sketchLine ?? sketchLine;
    }
    if (callee === 'circle') {
      const before = splitLines(result).length;
      result = await ensureSymbolImport(result, 'arc', 'fluidcad/core');
      sketchLine += splitLines(result).length - before;
    }
    return {
      newCode: result,
      ...(removed.length > 0 ? { removed } : {}),
      names: secondName !== null ? [name, secondName] : [name],
      sketchLine,
    };
  }

  /**
   * Every identifier in `body` that resolves to the entity binding, with the
   * point accessor it feeds (`l.end()`), excluding the binding itself.
   */
  private static referencesTo(name: string, declaration: TSNode, body: TSNode): Reference[] {
    const refs: Reference[] = [];
    for (const node of walkTree(body)) {
      if (node.type !== 'identifier' || node.text !== name) {
        continue;
      }
      if (SketchSplit.within(node, declaration) && !SketchSplit.withinCallArguments(node, declaration)) {
        continue;
      }
      if (!SketchSplit.resolvesTo(node, declaration, name)) {
        continue;
      }
      const statement = SketchSplit.bodyStatementOf(node, body);
      if (!statement) {
        continue;
      }
      refs.push({ node, statement, role: SketchSplit.accessorRole(node) });
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

  /** The point accessor a reference feeds: `l.end()` → 'end'; null for a bare use. */
  private static accessorRole(node: TSNode): string | null {
    const member = node.parent;
    if (!member || member.type !== 'member_expression' || member.childForFieldName('object')?.startIndex !== node.startIndex) {
      return null;
    }
    const property = member.childForFieldName('property');
    const call = member.parent;
    if (!property || !call || call.type !== 'call_expression') {
      return null;
    }
    return property.text;
  }

  /** The direct child statement of `body` that contains `node`. */
  private static bodyStatementOf(node: TSNode, body: TSNode): TSNode | null {
    for (let cur: TSNode | null = node; cur; cur = cur.parent) {
      if (cur.parent && SketchSplit.sameSpan(cur.parent, body)) {
        return cur;
      }
    }
    return null;
  }

  /** The constraint kind of a plain `kind(…);` statement, else null. */
  private static constraintKindOf(statement: TSNode): string | null {
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

  private static markRemoved(
    statement: TSNode,
    kind: string,
    removed: { line: number; kind: string }[],
    removedStatements: Set<number>,
  ): void {
    if (removedStatements.has(statement.startIndex)) {
      return;
    }
    removedStatements.add(statement.startIndex);
    removed.push({ line: statement.startPosition.row + 1, kind });
  }

  /** The statement's text with the given identifier nodes renamed. */
  private static replaceWithin(statement: TSNode, nodes: TSNode[], replacement: string): string {
    let text = statement.text;
    for (const node of [...nodes].sort((a, b) => b.startIndex - a.startIndex)) {
      const from = node.startIndex - statement.startIndex;
      text = text.slice(0, from) + replacement + text.slice(from + node.text.length);
    }
    return text;
  }

  /** The 1-indexed lines of the pieces' statements in the rewritten body. */
  private static async locatePieces(
    code: string,
    sketchLine: number,
    first: string,
    second: string | null,
  ): Promise<{ first: number; second: number | null } | null> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);
    const sketchCall = findEditableCallAt(tree, lines, sketchLine);
    const body = sketchCall ? findSketchBody(sketchCall) : null;
    if (!body) {
      return null;
    }
    let firstLine: number | null = null;
    let secondLine: number | null = null;
    for (const child of body.namedChildren) {
      const bound = boundVariableName(child);
      if (bound === first) {
        firstLine = child.startPosition.row + 1;
      } else if (second !== null && bound === second) {
        secondLine = child.startPosition.row + 1;
      }
    }
    if (firstLine === null || (second !== null && secondLine === null)) {
      return null;
    }
    return { first: firstLine, second: secondLine };
  }
}
