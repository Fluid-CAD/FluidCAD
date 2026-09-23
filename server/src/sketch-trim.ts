// The sketch Trim tool's statement transform.
//
// The kernel has cut the entity at its nearest crossings (lib
// `SketchEntitySplit.cut`) and the click named the piece to delete; this
// rewrites the source so the sketch reads as what is left. The statement
// keeps the first surviving piece under its own name; a second surviving
// piece (the middle of a line or arc was removed) binds right after it.
// Every reference to a point that vanished with the removed piece turns
// into the point's literal in geometry (the neighbour keeps its place) and
// deletes the constraint that named it. Constraints on the whole entity
// follow the rule tables; a listed entity of a derived op drops out of the
// list when the whole entity goes. Each new end is pinned to the entity
// that cut it, and two surviving arcs stay on one circle (center coincident
// + equal radii), so the trim takes nothing but the segment away.

import {
  ensureSymbolImport, findEditableCallAt, splitLines, type SketchPositionEdit, type TSNode, type TSTree,
} from './code-editor.ts';
import {
  allocateSolvedName,
  applySolvedEmission,
  boundVariableName,
  chainBase,
  collectIdentifiers,
  enclosingStatement,
  hoistSolvedStatement,
  type SolvedConstraintEmission,
  type SolvedEmissionTarget,
} from './sketch-solved-edit.ts';
import {
  LINE_RULES,
  ROUND_RULES,
  SketchEntityRewrite,
  pointText,
  type ConstraintRule,
  type Edit,
  type EntityCallee,
} from './sketch-entity-rewrite.ts';
import type { SplitPiece } from '../../lib/dist/features/2d/split.js';

export type SketchTrimSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  /** 1-indexed line of the entity statement being trimmed. */
  line: number;
  /**
   * Every piece the kernel cut, in travel order: one (nothing to cut at —
   * the whole entity goes), two (one end goes) or three (the middle goes)
   * for a line or an arc; the circle itself or its two arcs for a circle.
   */
  pieces: SplitPiece[];
  /** The index of the piece the click deletes. */
  removed: number;
  /**
   * Per cut (in travel order; a circle's two cuts bound its first piece),
   * the entity crossing there — the surviving end at that cut is pinned to
   * it with a coincident — or null to leave the end free. Addressed by the
   * lines of the source BEFORE this rewrite.
   */
  cutters?: (SolvedEmissionTarget | null)[];
  /**
   * Which piece a constraint that acts somewhere ALONG the entity (a point
   * on it, a tangency, a distance) touches — by constraint statement line,
   * resolved by the route from where it touches the entity. A constraint
   * touching the removed piece is deleted; unlisted ones stay on the first
   * surviving piece.
   */
  assignments?: { line: number; piece: number }[];
  /**
   * The sketch's drifted literals and their solved positions (the drag
   * write-back's batch), written first so the trim cuts a sketch already
   * at rest — see `SketchEntityRewrite.settle`.
   */
  settle?: SketchPositionEdit[];
};

export type SketchTrimResult = {
  newCode: string;
  error?: string;
  /** Constraint statements the trim deleted — their geometry is gone. */
  removed?: { line: number; kind: string }[];
  /** The binding names of the surviving pieces, in travel order. */
  names?: string[];
  /** The entity statement itself was deleted (nothing survived). */
  deleted?: boolean;
  /** The sketch statement's post-edit line (an added import shifts it). */
  sketchLine?: number;
};

/**
 * Trimmed arc pieces are not pinned to each other by a junction, so a
 * constraint touching the circumference belongs with the piece it touches
 * — and goes when that piece goes.
 */
const ROUND_TRIM_RULES: Record<string, ConstraintRule> = {
  ...ROUND_RULES,
  coincident: 'position',
  tangent: 'position',
  distance: 'position',
};

/** A surviving piece's end that sits at a cut. */
type CutEnd = { piece: number; role: 'start' | 'end' };

export class SketchTrim extends SketchEntityRewrite {
  static async apply(code: string, spec: SketchTrimSpec): Promise<SketchTrimResult> {
    const refuse = (error: string): SketchTrimResult => ({ newCode: code, error });
    if (!Number.isInteger(spec.removed) || spec.removed < 0 || spec.removed >= spec.pieces.length) {
      return refuse('the removed piece is not one of the pieces');
    }
    const settled = await SketchTrim.settle(code, spec.settle);
    if ('error' in settled) {
      return refuse(settled.error);
    }
    const source = settled.code;
    const entity = await SketchTrim.resolveEntity(source, spec.sketchLine, spec.line);
    if ('error' in entity) {
      return refuse(entity.error);
    }
    const { tree, lines, body, statement, base, callee, args, modifiers } = entity;
    if (!SketchTrim.piecesFit(callee, spec.pieces)) {
      return refuse(`line ${spec.line} is a ${callee}() statement now — the source changed since the pick was made`);
    }
    const pieces = spec.pieces;
    const last = pieces.length - 1;
    const cutCount = callee === 'circle' ? (pieces.length === 2 ? 2 : 0) : last;
    if (spec.cutters !== undefined && spec.cutters.length !== cutCount) {
      return refuse(`line ${spec.line} was cut ${cutCount} time(s) but ${spec.cutters.length} cutting edge(s) were named`);
    }
    const kept = pieces.map((_, i) => i).filter(i => i !== spec.removed);
    const whole = kept.length === 0;
    const pieceKind = callee === 'line' ? 'line' : 'arc';

    // Names: the statement's own for the first surviving piece, a fresh one
    // for a second. An unbound statement needs a name only when two pieces
    // survive and must be related to each other.
    const used = collectIdentifiers(tree);
    const edits: Edit[] = [];
    let name = entity.name;
    if (name === null && kept.length > 1) {
      const hoistEdits: { start: number; text: string }[] = [];
      name = hoistSolvedStatement(statement, callee, used, new Map(), hoistEdits);
      edits.push(...hoistEdits.map(e => ({ start: e.start, end: e.start, text: e.text })));
    }
    const names: (string | null)[] = pieces.map((): string | null => null);
    if (!whole) {
      names[kept[0]] = name;
    }
    if (kept.length > 1) {
      names[kept[1]] = allocateSolvedName(used, pieceKind);
    }

    // The statement's own rewrite: the first surviving piece replaces only
    // the arguments that changed, keeping every untouched argument's
    // expression verbatim; a second surviving piece binds right after it
    // with the same chained modifiers. A circle survives as an arc.
    const removedStatements = new Map<number, TSNode>();
    if (whole) {
      removedStatements.set(statement.startIndex, statement);
    } else if (callee === 'circle') {
      const arc = pieces[kept[0]] as Extract<SplitPiece, { kind: 'arc' }>;
      edits.push({
        start: base.startIndex, end: base.endIndex,
        text: `arc(${pointText(arc.start)}, ${pointText(arc.end)}, ${args[0].text})`,
      });
    } else {
      const first = pieces[kept[0]] as Exclude<SplitPiece, { kind: 'circle' }>;
      if (kept[0] !== 0) {
        edits.push({ start: args[0].startIndex, end: args[0].endIndex, text: pointText(first.start) });
      }
      if (kept[0] !== last) {
        edits.push({ start: args[1].startIndex, end: args[1].endIndex, text: pointText(first.end) });
      }
      if (kept.length > 1) {
        const second = pieces[kept[1]] as Exclude<SplitPiece, { kind: 'circle' }>;
        const secondEnd = kept[1] === last ? args[1].text : pointText(second.end);
        const text = callee === 'line'
          ? `line(${pointText(second.start)}, ${secondEnd})`
          : `arc(${pointText(second.start)}, ${secondEnd}, ${args[2].text})`;
        edits.push(SketchTrim.insertAfter(lines, statement, `const ${names[kept[1]]} = ${text}${modifiers};`));
      }
    }

    // Every other mention of the entity in the body.
    const removed: { line: number; kind: string }[] = [];
    const markRemoved = (target: TSNode, kind: string): void => {
      if (!removedStatements.has(target.startIndex)) {
        removedStatements.set(target.startIndex, target);
        removed.push({ line: target.startPosition.row + 1, kind });
      }
    };
    const rules = callee === 'line' ? LINE_RULES : ROUND_TRIM_RULES;
    const assignments = new Map((spec.assignments ?? []).map(a => [a.line, a.piece]));
    const duplicated = new Map<number, { statement: TSNode; nodes: TSNode[] }>();
    const secondName = kept.length > 1 ? names[kept[1]] : null;
    const superseded = SketchTrim.supersededPins(tree, lines, spec.cutters ?? []);
    const references = name !== null ? SketchTrim.referencesTo(name, statement, body) : [];
    for (const ref of references) {
      const constraintKind = SketchTrim.constraintKindOf(ref.statement);
      const refLine = ref.statement.startPosition.row + 1;
      // A point-on-curve pin an earlier trim left on a cutter's end is
      // superseded by the end-to-end pin this trim writes there: dropped,
      // not reported — the relation survives, tighter.
      if (ref.role === null && constraintKind === 'coincident' && SketchTrim.pinsOneOf(ref.statement, ref.node, superseded)) {
        removedStatements.set(ref.statement.startIndex, ref.statement);
        continue;
      }
      if (ref.role !== null) {
        const owner = SketchTrim.roleOwner(ref.role, callee, kept, last);
        if (owner === undefined) {
          return refuse(`line ${refLine} uses ${name}.${ref.role}() — not a point of a ${callee}`);
        }
        const to = owner === null ? null : names[owner];
        if (to !== null) {
          if (to !== name) {
            edits.push({ start: ref.node.startIndex, end: ref.node.endIndex, text: to });
          }
          continue;
        }
        // The point went with the removed piece: a constraint naming it has
        // nothing left to hold; geometry hanging off it keeps its place as
        // a literal.
        if (constraintKind !== null) {
          markRemoved(ref.statement, constraintKind);
          continue;
        }
        const literal = SketchTrim.vanishedPoint(ref.role, pieces);
        if (!literal) {
          return refuse(`line ${refLine} uses ${name}.${ref.role}() — that point is gone, remove the reference first`);
        }
        edits.push({ start: ref.accessor!.startIndex, end: ref.accessor!.endIndex, text: pointText(literal) });
        continue;
      }
      if (constraintKind === null) {
        // A derived op or geometry statement naming the whole entity.
        if (whole) {
          const drop = ref.node.parent?.type === 'array' ? SketchTrim.dropFromArray(ref.node) : null;
          if (!drop) {
            return refuse(`line ${refLine} uses ${name} — remove that statement first`);
          }
          edits.push(drop);
        } else if (secondName !== null && ref.node.parent?.type === 'array') {
          edits.push({ start: ref.node.endIndex, end: ref.node.endIndex, text: `, ${secondName}` });
        }
        continue;
      }
      switch (rules[constraintKind] ?? 'keep') {
        case 'duplicate': {
          if (whole) {
            markRemoved(ref.statement, constraintKind);
          } else if (secondName !== null) {
            const entry = duplicated.get(ref.statement.startIndex)
              ?? { statement: ref.statement, nodes: [] };
            entry.nodes.push(ref.node);
            duplicated.set(ref.statement.startIndex, entry);
          }
          break;
        }
        case 'position': {
          const assigned = assignments.get(refLine);
          const target = assigned !== undefined && assigned >= 0 && assigned <= last ? assigned : kept[0];
          const to = target === undefined ? null : names[target];
          if (to === null) {
            markRemoved(ref.statement, constraintKind);
          } else if (to !== name) {
            edits.push({ start: ref.node.startIndex, end: ref.node.endIndex, text: to });
          }
          break;
        }
        case 'remove':
          markRemoved(ref.statement, constraintKind);
          break;
        case 'keep':
          if (whole) {
            markRemoved(ref.statement, constraintKind);
          }
          break;
      }
    }
    for (const { statement: dup, nodes } of duplicated.values()) {
      if (!removedStatements.has(dup.startIndex)) {
        edits.push(SketchTrim.copyAfter(lines, dup, nodes, secondName!));
      }
    }
    const spliced = SketchTrim.splice(source, lines, edits, removedStatements.values());
    if ('error' in spliced) {
      return refuse(spliced.error);
    }
    let result = spliced.code;
    let sketchLine = spec.sketchLine;

    // The constraints the trim adds, rendered through the emission rail,
    // which places, imports and hoists like any drawing tool: each new end
    // pinned to the entity that cut it; two surviving pieces related —
    // adjacent ones (the first piece went) still share their junction, arcs
    // stay on one circle either way. Statements are addressed by their
    // post-rewrite lines: the first survivor is the statement itself, the
    // second the line inserted right after it.
    if (!whole) {
      const { remapLine } = spliced;
      const firstLine = remapLine(spec.line);
      const secondLine = remapLine(statement.endPosition.row + 1) + 1;
      const lineOf = (piece: number): number => piece === kept[0] ? firstLine : secondLine;
      const featureType = pieceKind;
      const constraints: SolvedConstraintEmission[] = [];
      (spec.cutters ?? []).forEach((cutter, cut) => {
        const end = SketchTrim.cutEnd(callee, kept, cut);
        if (cutter && end) {
          constraints.push({
            kind: 'coincident',
            targets: [
              { line: lineOf(end.piece), role: end.role, featureType },
              SketchTrim.remapTarget(cutter, remapLine),
            ],
          });
        }
      });
      if (kept.length === 2) {
        const first = lineOf(kept[0]);
        const second = lineOf(kept[1]);
        if (kept[1] === kept[0] + 1) {
          constraints.push({
            kind: 'coincident',
            targets: [{ line: first, role: 'end', featureType }, { line: second, role: 'start', featureType }],
          });
        }
        if (pieceKind === 'arc') {
          constraints.push({
            kind: 'coincident',
            targets: [{ line: first, role: 'center', featureType }, { line: second, role: 'center', featureType }],
          });
          if (kept[1] !== kept[0] + 1) {
            constraints.push({ kind: 'equal', targets: [{ line: first, featureType }, { line: second, featureType }] });
          }
        }
      }
      if (constraints.length > 0) {
        const emission = await applySolvedEmission(result, { sketchLine: spec.sketchLine, geometry: [], constraints });
        if (emission.error) {
          return refuse(emission.error);
        }
        result = emission.newCode;
        sketchLine = emission.sketchLine ?? sketchLine;
      }
    }
    if (callee === 'circle' && !whole) {
      const before = splitLines(result).length;
      result = await ensureSymbolImport(result, 'arc', 'fluidcad/core');
      sketchLine += splitLines(result).length - before;
    }
    return {
      newCode: result,
      ...(removed.length > 0 ? { removed } : {}),
      names: kept.map(i => names[i]).filter((n): n is string => n !== null),
      ...(whole ? { deleted: true } : {}),
      sketchLine,
    };
  }

  /** Whether the kernel's pieces are the shape the statement's primitive yields. */
  private static piecesFit(callee: EntityCallee, pieces: SplitPiece[]): boolean {
    if (callee === 'circle') {
      return (pieces.length === 1 && pieces[0].kind === 'circle')
        || (pieces.length === 2 && pieces.every(p => p.kind === 'arc'));
    }
    return pieces.length >= 1 && pieces.length <= 3 && pieces.every(p => p.kind === callee);
  }

  /**
   * The surviving end at cut `cut`: for a line or arc, cut `j` joins pieces
   * `j` and `j + 1`, so it is the end of piece `j` or the start of piece
   * `j + 1`, whichever survives. A circle's two arcs share both cuts: the
   * first arc runs from cut 0 to cut 1, the second from cut 1 back to cut 0.
   */
  private static cutEnd(callee: EntityCallee, kept: number[], cut: number): CutEnd | null {
    if (callee === 'circle') {
      const piece = kept[0];
      if (piece === undefined) {
        return null;
      }
      return { piece, role: (cut === 0) === (piece === 0) ? 'start' : 'end' };
    }
    if (kept.includes(cut)) {
      return { piece: cut, role: 'end' };
    }
    if (kept.includes(cut + 1)) {
      return { piece: cut + 1, role: 'start' };
    }
    return null;
  }

  /**
   * The accessor texts (`l1.end()`) of the cutter ends this trim pins end
   * to end — a bare-statement cutter whose crossing sits at its own end.
   * A `coincident(<accessor>, <entity>)` already in the body is the
   * point-on-curve pin an earlier trim left there, now superseded.
   */
  private static supersededPins(tree: TSTree, lines: string[], cutters: (SolvedEmissionTarget | null)[]): Set<string> {
    const accessors = new Set<string>();
    for (const cutter of cutters) {
      if (!cutter?.role || cutter.line === undefined || cutter.source !== undefined
        || cutter.refIndex !== undefined || cutter.instanceIndex !== undefined) {
        continue;
      }
      const call = findEditableCallAt(tree, lines, cutter.line);
      const bound = call ? boundVariableName(enclosingStatement(call)) : null;
      if (bound !== null) {
        accessors.add(`${bound}.${cutter.role}()`);
      }
    }
    return accessors;
  }

  /** Whether a two-argument constraint pairs the bare reference `bare` with one of `accessors`. */
  private static pinsOneOf(statement: TSNode, bare: TSNode, accessors: Set<string>): boolean {
    if (accessors.size === 0 || statement.type !== 'expression_statement') {
      return false;
    }
    const call = statement.namedChild(0);
    if (!call || call.type !== 'call_expression') {
      return false;
    }
    const args = chainBase(call).childForFieldName('arguments')?.namedChildren ?? [];
    if (args.length !== 2) {
      return false;
    }
    const other = args.find(a => a.startIndex > bare.endIndex || a.endIndex < bare.startIndex);
    return other !== undefined && accessors.has(other.text.replace(/\s+/g, ''));
  }

  /** A cutter target with its statement line(s) moved to where the rewrite left them. */
  private static remapTarget(target: SolvedEmissionTarget, remapLine: (line: number) => number): SolvedEmissionTarget {
    return {
      ...target,
      ...(target.line !== undefined ? { line: remapLine(target.line) } : {}),
      ...(target.source !== undefined ? { source: SketchTrim.remapTarget(target.source, remapLine) } : {}),
    };
  }

  /**
   * The piece that owns a point accessor after the cut: the first piece owns
   * `.start()`, the last `.end()`, every surviving piece `.center()`; null
   * when no piece has it (`.mid()` of the whole line); undefined for an
   * accessor the primitive does not have.
   */
  private static roleOwner(role: string, callee: EntityCallee, kept: number[], last: number): number | null | undefined {
    switch (role) {
      case 'start':
        return callee === 'circle' ? undefined : 0;
      case 'end':
        return callee === 'circle' ? undefined : last;
      case 'center':
        return callee === 'line' ? undefined : kept[0] ?? null;
      case 'mid':
        return callee === 'line' ? null : undefined;
      default:
        return undefined;
    }
  }

  /** Where a point that no surviving piece owns used to be — the literal geometry keeps. */
  private static vanishedPoint(role: string, pieces: SplitPiece[]): [number, number] | null {
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    switch (role) {
      case 'start':
        return first.kind === 'circle' ? null : first.start;
      case 'end':
        return last.kind === 'circle' ? null : last.end;
      case 'center':
        return first.kind === 'line' ? null : first.center;
      case 'mid':
        return first.kind !== 'line' || last.kind !== 'line'
          ? null
          : [(first.start[0] + last.end[0]) / 2, (first.start[1] + last.end[1]) / 2];
      default:
        return null;
    }
  }

  /** The edit dropping `node` out of its array literal, or null when it is the only element. */
  private static dropFromArray(node: TSNode): Edit | null {
    const elements = node.parent!.namedChildren;
    const index = elements.findIndex(e => e.startIndex === node.startIndex);
    if (elements.length < 2 || index === -1) {
      return null;
    }
    return index === 0
      ? { start: node.startIndex, end: elements[1].startIndex, text: '' }
      : { start: elements[index - 1].endIndex, end: node.endIndex, text: '' };
  }
}
