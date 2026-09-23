// The sketch Split tool's statement transform.
//
// The kernel has already cut the entity (lib `SketchEntitySplit`); this
// rewrites the source so the sketch reads as the cut geometry: the statement
// keeps the first piece (and its name, so every `.start()` / `.center()`
// reference stays valid), a new binding right after it takes the second
// piece, `.end()` references move to the new binding, and the constraints
// that addressed the whole entity follow the rule table. The junction
// coincident(s) then ride the ordinary insert-solved emission rail.

import { ensureSymbolImport, splitLines, type SketchPositionEdit, type TSNode } from './code-editor.ts';
import {
  applySolvedEmission,
  hoistSolvedStatement,
  type SolvedConstraintEmission,
} from './sketch-solved-edit.ts';
import { allocateSolvedName, collectIdentifiers } from './sketch-names.ts';
import {
  LINE_RULES,
  ROUND_RULES,
  SketchEntityRewrite,
  pointText,
  type Edit,
} from './sketch-entity-rewrite.ts';
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
  /**
   * The sketch's drifted literals and their solved positions (the drag
   * write-back's batch), written first so the split cuts a sketch already
   * at rest — see `SketchEntityRewrite.settle`.
   */
  settle?: SketchPositionEdit[];
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

export class SketchSplit extends SketchEntityRewrite {
  static async apply(code: string, spec: SketchSplitSpec): Promise<SketchSplitResult> {
    const refuse = (error: string): SketchSplitResult => ({ newCode: code, error });
    if (spec.pieces.length < 1 || spec.pieces.length > 2) {
      return refuse('a split yields one or two pieces');
    }
    const settled = await SketchSplit.settle(code, spec.settle);
    if ('error' in settled) {
      return refuse(settled.error);
    }
    const source = settled.code;
    const entity = await SketchSplit.resolveEntity(source, spec.sketchLine, spec.line);
    if ('error' in entity) {
      return refuse(entity.error);
    }
    const { tree, lines, body, statement, base, callee, args, modifiers } = entity;
    const expectedPieces = callee === 'circle' ? 1 : 2;
    const pieceKind = callee === 'line' ? 'line' : 'arc';
    if (spec.pieces.length !== expectedPieces || spec.pieces.some(p => p.kind !== pieceKind)) {
      return refuse(`line ${spec.line} is a ${callee}() statement now — the source changed since the pick was made`);
    }
    const pieces = spec.pieces as Exclude<SplitPiece, { kind: 'circle' }>[];

    const used = collectIdentifiers(tree);
    const edits: Edit[] = [];
    const hoistEdits: { start: number; text: string }[] = [];
    const name = hoistSolvedStatement(statement, callee, used, new Map(), hoistEdits);
    edits.push(...hoistEdits.map(e => ({ start: e.start, end: e.start, text: e.text })));
    const secondName = pieces.length === 2 ? allocateSolvedName(used, pieceKind) : null;

    // The statement's own rewrite: the first piece replaces the arguments
    // that changed (the end, or the whole circle call), keeping every
    // untouched argument's expression — a variable, an accessor — verbatim.
    // Chained modifiers (`.cw()`, `.guide()`) stay on the statement and are
    // copied onto the second piece, which shares its sweep side.
    const at = pieces[0].end;
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
    if (secondText !== null) {
      edits.push(SketchSplit.insertAfter(lines, statement, `const ${secondName} = ${secondText}${modifiers};`));
    }

    // Every other mention of the entity in the body follows its rule.
    const references = SketchSplit.referencesTo(name, statement, body);
    const rules = callee === 'line' ? LINE_RULES : ROUND_RULES;
    const assignments = new Map((spec.assignments ?? []).map(a => [a.line, a.piece]));
    const removed: { line: number; kind: string }[] = [];
    const removedStatements = new Map<number, TSNode>();
    const markRemoved = (target: TSNode, kind: string): void => {
      if (!removedStatements.has(target.startIndex)) {
        removedStatements.set(target.startIndex, target);
        removed.push({ line: target.startPosition.row + 1, kind });
      }
    };
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
          markRemoved(ref.statement, constraintKind);
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
          markRemoved(ref.statement, constraintKind);
          break;
        case 'keep':
          break;
      }
    }
    for (const { statement: dup, nodes } of duplicated.values()) {
      if (!removedStatements.has(dup.startIndex)) {
        edits.push(SketchSplit.copyAfter(lines, dup, nodes, secondName!));
      }
    }
    const spliced = SketchSplit.splice(source, lines, edits, removedStatements.values());
    if ('error' in spliced) {
      return refuse(spliced.error);
    }
    const working = spliced.code;

    // The junction: the pieces share their cut point, arcs their center
    // too. Rendered through the emission rail, which places, imports and
    // hoists like any drawing-tool constraint.
    const names = secondName !== null ? [name, secondName] : [name];
    const located = await SketchSplit.locateBindings(working, spec.sketchLine, names);
    if (!located) {
      return refuse('the split statements could not be located after the rewrite');
    }
    let result = working;
    let sketchLine = spec.sketchLine;
    if (secondName !== null) {
      const first = located.get(name)!;
      const second = located.get(secondName)!;
      const featureType = pieceKind;
      const constraints: SolvedConstraintEmission[] = [{
        kind: 'coincident',
        targets: [
          { line: first, role: 'end', featureType },
          { line: second, role: 'start', featureType },
        ],
      }];
      if (pieceKind === 'arc') {
        constraints.push({
          kind: 'coincident',
          targets: [
            { line: first, role: 'center', featureType },
            { line: second, role: 'center', featureType },
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
      names,
      sketchLine,
    };
  }
}
